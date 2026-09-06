import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { IdmlDocument } from '../src/idml/document.ts';
import { listItems } from '../src/idml/items.ts';
import { listPages } from '../src/idml/pages.ts';
import { listStyles, listSwatches } from '../src/idml/styles.ts';
import { createDocument } from '../src/idml/template.ts';
import { validateDocument } from '../src/idml/validate.ts';
import { ReferenceCatalog } from '../src/references/catalog.ts';
import { copyMaster, copyPage, importStyles } from '../src/references/importer.ts';
import { createServer } from '../src/server.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'idml');

describe('reference catalog', () => {
  test('lists bundled references and folders', () => {
    const cat = new ReferenceCatalog([FIXTURES]);
    const names = cat.list().map((r) => r.name);
    expect(names).toContain('magazine-interview');
    expect(names).toContain('interview');
    expect(cat.find('Magazine-Interview').source).toBe('bundled');
    expect(() => cat.find('nope')).toThrow(/not found/);
    const { summary } = cat.summary('magazine-template', 'mm');
    expect(summary.pageCount).toBeGreaterThan(0);
  });
});

describe('importer', () => {
  test('imports styles, swatches and fonts with conflict handling', () => {
    const from = IdmlDocument.load(join(FIXTURES, 'interview.idml'));
    const to = createDocument({ pageSize: 'A4' });
    const report = importStyles(from, to);
    expect(report.paragraphStyles).toContain('Question');
    expect(report.characterStyles).toContain('black');
    expect(report.swatches.length).toBeGreaterThan(0);
    const names = listStyles(to, 'ParagraphStyle').map((s) => s.name);
    expect(names).toContain('Question');
    expect(names).toContain('reponse');
    const q = listStyles(to, 'ParagraphStyle').find((s) => s.name === 'Question')!;
    // its fill color swatch was copied too
    expect(listSwatches(to).some((s) => s.self === q.fillColor)).toBe(true);
    const second = importStyles(from, to, { paragraph: true });
    expect(second.paragraphStyles).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
    const renamed = importStyles(from, to, { paragraph: true, only: ['Question'], conflict: 'rename' });
    expect(renamed.paragraphStyles).toEqual(['Question 2']);
    const again = IdmlDocument.fromBytes(to.toBytes());
    expect(validateDocument(again).filter((i) => i.level === 'error')).toEqual([]);
  });

  test('copies a master and a page with items and stories', () => {
    const from = IdmlDocument.load(join(FIXTURES, '4-pages.idml'));
    const to = createDocument({ pageSize: 'A4', facingPages: true });
    const m = copyMaster(from, to, 'A-Master');
    expect(to.masterSpreads().map((x) => x.getAttribute('Self'))).toContain(m.id);
    const before = listPages(to).length;
    const sourceItems = listItems(from, { page: 1 }).length;
    const r = copyPage(from, to, 1);
    expect(listPages(to).length).toBe(before + 1);
    expect(r.items).toBe(sourceItems);
    const copied = listItems(to, { page: r.page.index });
    expect(copied.length).toBe(sourceItems);
    const texts = copied.filter((i) => i.type === 'text');
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(to.story(t.storyId!)).toBeDefined();
    const src = listItems(from, { page: 1 }).find((i) => i.type === 'text')!;
    const dst = copied.find((i) => i.type === 'text' && i.text === src.text)!;
    expect(dst.bounds!.x).toBeCloseTo(src.bounds!.x, 1);
    expect(dst.bounds!.y).toBeCloseTo(src.bounds!.y, 1);
    const again = IdmlDocument.fromBytes(to.toBytes());
    expect(validateDocument(again).filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('reference tools', () => {
  let client: Client;
  let dir: string;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      text: (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n'),
      data: r.structuredContent as Record<string, unknown> | undefined,
      isError: Boolean(r.isError),
    };
  };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-ref-'));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer(
      loadConfig({ INDESIGN_MCP_DOCUMENTS: dir, INDESIGN_MCP_REFERENCES: FIXTURES }),
    ).connect(st);
    client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
  });

  test('list, describe, new from reference, import, copy', async () => {
    let r = await call('list', { what: 'reference_documents' });
    expect(r.text).toContain('magazine-interview');
    expect(r.text).toContain('4-pages');
    r = await call('describe_reference', { reference: 'magazine-interview' });
    expect(r.text).toContain('Question');
    r = await call('new_document_from_reference', {
      reference: 'magazine-template',
      path: 'from-ref',
      pages: 2,
    });
    expect(r.isError).toBe(false);
    const doc = r.data!.path as string;
    expect(listPages(IdmlDocument.load(doc))).toHaveLength(2);
    expect(listItems(IdmlDocument.load(doc))).toHaveLength(0);
    r = await call('import_styles_from_reference', {
      document: doc,
      reference: 'magazine-interview',
      paragraph: true,
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Question');
    r = await call('copy_page_from_reference', { document: doc, reference: '4-pages', page: 1 });
    expect(r.isError).toBe(false);
    expect(r.data!.items as number).toBeGreaterThan(0);
    r = await call('copy_master_from_reference', {
      document: doc,
      reference: 'interview',
      master: 'A-Gabarit',
    });
    expect(r.isError).toBe(false);
    r = await call('validate_document', { document: doc });
    expect(r.data!.errors).toBe(0);
    const { resources } = await client.listResources();
    expect(resources.some((x) => x.uri === 'reference://magazine-interview')).toBe(true);
    const read = await client.readResource({ uri: 'reference://magazine-interview' });
    expect((read.contents[0] as { text: string }).text).toContain('Page 1');
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('design-from-brief');
    const prompt = await client.getPrompt({
      name: 'design-from-brief',
      arguments: { brief: 'A bakery flyer' },
    });
    expect(JSON.stringify(prompt.messages)).toContain('bakery');
  });
});
