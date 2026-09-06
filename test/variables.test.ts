// Text variables and the automatic character styling InDesign applies inside paragraphs.
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { IdmlDocument } from '../src/idml/document.ts';
import { createTextFrame, findItem } from '../src/idml/items.ts';
import { validateAgainstSchema } from '../src/idml/schema.ts';
import { readStoryPlainText } from '../src/idml/stories.ts';
import { createCharacterStyle, createParagraphStyle, resolveStyle } from '../src/idml/styles.ts';
import { createDocument } from '../src/idml/template.ts';
import { validateDocument } from '../src/idml/validate.ts';
import {
  createTextVariable,
  deleteTextVariable,
  formatDate,
  insertTextVariable,
  listTextVariables,
  readStyleAutomation,
  setGrepStyles,
  setLineStyles,
  setNestedStyles,
} from '../src/idml/variables.ts';
import { createServer } from '../src/server.ts';

function errorsOf(doc: IdmlDocument): string[] {
  const again = IdmlDocument.fromBytes(doc.toBytes());
  return [
    ...validateDocument(again)
      .filter((i) => i.level === 'error')
      .map((i) => `${i.part}: ${i.message}`),
    ...validateAgainstSchema(again)
      .issues.filter((i) => i.level === 'error')
      .map((i) => `${i.part} ${i.path}: ${i.message}`),
  ];
}

function docWithFrame(): { doc: IdmlDocument; story: ReturnType<IdmlDocument['story']> } {
  const doc = createDocument({ pageSize: 'A4' });
  const frame = createTextFrame(
    doc,
    { page: 1 },
    { rect: { x: 20, y: 20, width: 300, height: 60 }, text: 'Chapter title — page ', name: 'Header' },
  );
  return { doc, story: doc.story(frame.getAttribute('ParentStory')!) };
}

describe('text variables', () => {
  test('creates the different kinds and lists them', () => {
    const doc = createDocument({ pageSize: 'A4' });
    createParagraphStyle(doc, { name: 'Heading 1', size: 18 });
    createTextVariable(doc, { name: 'Running head', kind: 'running-header-paragraph', style: 'Heading 1' });
    createTextVariable(doc, { name: 'Today', kind: 'modification-date', format: 'd MMMM yyyy' });
    createTextVariable(doc, { name: 'Client', kind: 'custom-text', text: 'Acme Ltd' });
    createTextVariable(doc, { name: 'Pages', kind: 'last-page-number' });
    // the template already carries InDesign's own default variables, so ours are added to those
    const variables = listTextVariables(doc);
    const names = variables.map((v) => v.name);
    expect(names).toContain('Client');
    expect(names).toContain('Pages');
    expect(names).toContain('Running head');
    expect(names).toContain('Today');
    expect(names.some((n) => n.startsWith('<?AID'))).toBe(false);
    expect(variables.find((v) => v.name === 'Client')!.detail).toBe('Acme Ltd');
    expect(variables.find((v) => v.name === 'Running head')!.kind).toBe('running-header-paragraph');
    expect(errorsOf(doc)).toEqual([]);
  });

  test('creating a variable twice replaces it', () => {
    const doc = createDocument({ pageSize: 'A4' });
    createTextVariable(doc, { name: 'Client', kind: 'custom-text', text: 'First' });
    createTextVariable(doc, { name: 'Client', kind: 'custom-text', text: 'Second' });
    const mine = () => listTextVariables(doc).filter((v) => v.name === 'Client');
    expect(mine()).toHaveLength(1);
    expect(mine()[0]!.detail).toBe('Second');
    deleteTextVariable(doc, 'Client');
    expect(mine()).toHaveLength(0);
    expect(() => deleteTextVariable(doc, 'Client')).toThrow(/No text variable/);
  });

  test('inserts a variable in place of text and at the end of a story', () => {
    const { doc, story } = docWithFrame();
    createTextVariable(doc, { name: 'Client', kind: 'custom-text', text: 'Acme Ltd' });
    createTextVariable(doc, { name: 'Pages', kind: 'last-page-number' });
    insertTextVariable(doc, story!, 'Client', { find: 'Chapter title' });
    insertTextVariable(doc, story!, 'Pages');
    // the resolved text of a custom variable shows up in the story text
    expect(readStoryPlainText(story!)).toBe('Acme Ltd — page ');
    const instances = Array.from(story!.getElementsByTagName('TextVariableInstance'));
    expect(instances).toHaveLength(2);
    expect(instances[0]!.getAttribute('Name')).toBe('Client');
    expect(errorsOf(doc)).toEqual([]);
  });

  test('the file name variable resolves to the document name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-vars-'));
    const { doc, story } = docWithFrame();
    doc.save(join(dir, 'brochure.idml'));
    createTextVariable(doc, { name: 'File', kind: 'file-name', includeExtension: false });
    insertTextVariable(doc, story!, 'File', { find: 'Chapter title' });
    expect(readStoryPlainText(story!)).toContain('brochure');
  });

  test('formats dates the way InDesign patterns do', () => {
    const date = new Date(2026, 8, 6, 14, 5);
    expect(formatDate(date, 'dd/MM/yyyy')).toBe('06/09/2026');
    expect(formatDate(date, 'd MMMM yyyy')).toBe('6 September 2026');
    expect(formatDate(date, 'MMM d, yy HH:mm')).toBe('Sep 6, 26 14:05');
  });
});

describe('nested, line and GREP styles', () => {
  test('writes them onto a paragraph style and reads them back', () => {
    const doc = createDocument({ pageSize: 'A4' });
    createParagraphStyle(doc, { name: 'Intro', size: 11 });
    createCharacterStyle(doc, { name: 'Lead in', fontStyle: 'Bold' });
    createCharacterStyle(doc, { name: 'Number', color: 'cmyk(0,100,100,0)' });
    createCharacterStyle(doc, { name: 'Small caps', capitalization: 'small-caps' });
    const style = resolveStyle(doc, 'ParagraphStyle', 'Intro');
    setNestedStyles(doc, style, [
      { characterStyle: 'Lead in', through: 'AnyWord', repetition: 2 },
      { characterStyle: 'Small caps', through: ':', inclusive: false },
    ]);
    setLineStyles(doc, style, [{ characterStyle: 'Small caps', lines: 1 }]);
    setGrepStyles(doc, style, [{ characterStyle: 'Number', pattern: '\\d+([.,]\\d+)?' }]);
    const read = readStyleAutomation(style);
    expect(read.nested).toHaveLength(2);
    expect(read.nested[0]!.through).toBe('AnyWord');
    expect(read.nested[0]!.repetition).toBe(2);
    expect(read.nested[1]!.inclusive).toBe(false);
    expect(read.lines[0]!.lines).toBe(1);
    expect(read.grep[0]!.pattern).toBe('\\d+([.,]\\d+)?');
    expect(style.getAttribute('EmptyNestedStyles')).toBe('false');
    expect(style.getAttribute('EmptyGrepStyles')).toBe('false');
    expect(errorsOf(doc)).toEqual([]);
  });

  test('an empty list removes them again', () => {
    const doc = createDocument({ pageSize: 'A4' });
    createParagraphStyle(doc, { name: 'Intro', size: 11 });
    createCharacterStyle(doc, { name: 'Lead in', fontStyle: 'Bold' });
    const style = resolveStyle(doc, 'ParagraphStyle', 'Intro');
    setNestedStyles(doc, style, [{ characterStyle: 'Lead in', through: 'Sentence' }]);
    setNestedStyles(doc, style, []);
    expect(readStyleAutomation(style).nested).toHaveLength(0);
    expect(style.getAttribute('EmptyNestedStyles')).toBe('true');
    expect(errorsOf(doc)).toEqual([]);
  });
});

describe('variable and nested style tools over MCP', () => {
  let client: Client;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      text: (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n'),
      data: r.structuredContent as Record<string, unknown> | undefined,
      isError: Boolean(r.isError),
    };
  };
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-variables-'));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer(
      loadConfig({ INDESIGN_MCP_DOCUMENTS: dir, INDESIGN_MCP_DISABLE_INDESIGN: '1' }),
    ).connect(st);
    client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
  });

  test('a report with a running header, a date and automatic styling', async () => {
    const created = await call('new_document', { path: 'report', pageSize: 'A4', pages: 2 });
    const document = created.data!.path as string;

    await call('create_paragraph_style', { document, name: 'Heading 1', size: 18, fontStyle: 'Bold' });
    await call('create_character_style', { document, name: 'Figures', color: 'cmyk(0,100,100,0)' });

    const variable = await call('create_text_variable', {
      document,
      name: 'Running head',
      kind: 'running-header-paragraph',
      style: 'Heading 1',
    });
    expect(variable.isError).toBe(false);
    await call('create_text_variable', {
      document,
      name: 'Printed',
      kind: 'output-date',
      format: 'd MMMM yyyy',
    });

    const listed = await call('list', { what: 'text_variables', document });
    expect(listed.text).toContain('Running head');
    expect(listed.text).toContain('Printed');

    const header = await call('add_text_frame', {
      document,
      page: 1,
      x: 20,
      y: 10,
      width: 170,
      height: 8,
      text: 'HEADER · DATE',
      name: 'Header',
    });
    expect(header.isError).toBe(false);
    const inserted = await call('insert_text_variable', {
      document,
      item: 'Header',
      variable: 'Running head',
      replaceText: 'HEADER',
    });
    expect(inserted.isError).toBe(false);
    await call('insert_text_variable', {
      document,
      item: 'Header',
      variable: 'Printed',
      replaceText: 'DATE',
    });

    const grep = await call('set_grep_styles', {
      document,
      style: 'Heading 1',
      grep: [{ characterStyle: 'Figures', pattern: '\\d+' }],
    });
    expect(grep.isError).toBe(false);
    const nested = await call('set_nested_styles', {
      document,
      style: 'Heading 1',
      nested: [{ characterStyle: 'Figures', through: 'AnyWord', repetition: 1 }],
    });
    expect(nested.isError).toBe(false);

    const validated = await call('validate_document', { document });
    expect(validated.data!.errors).toBe(0);

    const doc = IdmlDocument.load(document);
    const names = listTextVariables(doc).map((v) => v.name);
    expect(names).toContain('Running head');
    expect(names).toContain('Printed');
    const frame = findItem(doc, 'Header').element;
    const story = doc.story(frame.getAttribute('ParentStory')!)!;
    expect(Array.from(story.getElementsByTagName('TextVariableInstance'))).toHaveLength(2);
    expect(readStyleAutomation(resolveStyle(doc, 'ParagraphStyle', 'Heading 1')).grep[0]!.pattern).toBe(
      '\\d+',
    );
  });
});
