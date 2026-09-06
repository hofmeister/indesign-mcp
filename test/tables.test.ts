import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { IdmlDocument } from '../src/idml/document.ts';
import { createRectangle, createTextFrame, findItem, listItems } from '../src/idml/items.ts';
import { listPages } from '../src/idml/pages.ts';
import { validateAgainstSchema } from '../src/idml/schema.ts';
import { readStoryPlainText } from '../src/idml/stories.ts';
import { createParagraphStyle, resolveStyle } from '../src/idml/styles.ts';
import {
  createTable,
  deleteTableColumns,
  deleteTableRows,
  findTable,
  insertTableColumns,
  insertTableRows,
  mergeCells,
  setCellText,
  styleCells,
  tableInfo,
  tableToText,
} from '../src/idml/tables.ts';
import { createDocument } from '../src/idml/template.ts';
import {
  anchorItem,
  applyListSettings,
  createHyperlink,
  expandSpecialCharacters,
  formatPageNumber,
  listHyperlinks,
  readTabStops,
  setSection,
  setTabStops,
} from '../src/idml/typography.ts';
import { validateDocument } from '../src/idml/validate.ts';
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

function docWithFrame(): { doc: IdmlDocument; frame: ReturnType<typeof createTextFrame> } {
  const doc = createDocument({ pageSize: 'A4' });
  const frame = createTextFrame(
    doc,
    { page: 1 },
    { rect: { x: 40, y: 40, width: 400, height: 300 }, text: '', name: 'Table frame' },
  );
  return { doc, frame };
}

describe('tables', () => {
  test('creates a table with headers, banding and data', () => {
    const { doc, frame } = docWithFrame();
    const table = createTable(doc, frame, {
      rows: 4,
      columns: 3,
      headerRows: 1,
      data: [
        ['Product', 'Price', 'Stock'],
        ['Bread', '25', '12'],
        ['Cake', '60', '4'],
        ['Coffee', '35', '20'],
      ],
      headerFill: 'cmyk(0,0,0,20)',
      alternatingFill: 'cmyk(0,0,0,7)',
      strokeWeight: 0.5,
    });
    const info = tableInfo(table);
    expect(info.rows).toBe(4);
    expect(info.columns).toBe(3);
    expect(info.headerRows).toBe(1);
    expect(info.cells[0]![0]!.text).toBe('Product');
    expect(info.cells[3]![2]!.text).toBe('20');
    expect(info.cells[0]![0]!.fill).toBeTruthy(); // header fill
    expect(info.columnWidths.every((w) => w > 100)).toBe(true);
    expect(errorsOf(doc)).toEqual([]);

    const again = IdmlDocument.fromBytes(doc.toBytes());
    const reloaded = findTable(again, findItem(again, 'Table frame').element);
    expect(tableToText(reloaded).split('\n')[0]).toBe('Product | Price | Stock');
  });

  test('edits cells and structure', () => {
    const { doc, frame } = docWithFrame();
    const table = createTable(doc, frame, {
      rows: 3,
      columns: 2,
      data: [
        ['a', 'b'],
        ['c', 'd'],
        ['e', 'f'],
      ],
    });
    setCellText(doc, table, 1, 1, 'changed');
    expect(tableInfo(table).cells[1]![1]!.text).toBe('changed');

    insertTableRows(doc, table, 1, 2);
    let info = tableInfo(table);
    expect(info.rows).toBe(5);
    expect(info.cells[0]![0]!.text).toBe('a');
    expect(info.cells[1]![0]!.text).toBe(''); // inserted, empty
    expect(info.cells[3]![1]!.text).toBe('changed'); // moved down by 2

    insertTableColumns(doc, table, 0, 1);
    info = tableInfo(table);
    expect(info.columns).toBe(3);
    expect(info.cells[0]![0]!.text).toBe(''); // new first column
    expect(info.cells[0]![1]!.text).toBe('a');

    deleteTableColumns(table, 0, 1);
    deleteTableRows(table, 1, 2);
    info = tableInfo(table);
    expect(info.rows).toBe(3);
    expect(info.columns).toBe(2);
    expect(info.cells.map((r) => r.map((c) => c?.text))).toEqual([
      ['a', 'b'],
      ['c', 'changed'],
      ['e', 'f'],
    ]);
    expect(errorsOf(doc)).toEqual([]);
  });

  test('merges cells and styles ranges', () => {
    const { doc, frame } = docWithFrame();
    const table = createTable(doc, frame, {
      rows: 3,
      columns: 3,
      data: [
        ['title', '', ''],
        ['a', 'b', 'c'],
        ['d', 'e', 'f'],
      ],
    });
    mergeCells(table, 0, 0, 1, 3);
    const info = tableInfo(table);
    expect(info.cells[0]![0]!.columnSpan).toBe(3);
    expect(info.cells[0]![1]).toBeUndefined();
    const n = styleCells(
      doc,
      table,
      { rows: [0] },
      { fill: 'cmyk(0,0,0,15)', verticalJustification: 'center' },
    );
    expect(n).toBe(1); // the merged cell only
    expect(styleCells(doc, table, undefined, { inset: 6 })).toBe(7);
    expect(errorsOf(doc)).toEqual([]);
  });

  test('rejects impossible operations with a helpful message', () => {
    const { doc, frame } = docWithFrame();
    const table = createTable(doc, frame, { rows: 2, columns: 2 });
    expect(() => setCellText(doc, table, 5, 0, 'x')).toThrow(/no cell at row 6/);
    expect(() => mergeCells(table, 0, 0, 5, 1)).toThrow(/outside the table/);
    expect(() => createTable(doc, findItem(doc, 'Table frame').element, { rows: 200, columns: 100 })).toThrow(
      /5000 cells/,
    );
  });
});

describe('lists, tabs and special characters', () => {
  test('bullets and numbering on paragraph styles', () => {
    const doc = createDocument({ pageSize: 'A4' });
    createParagraphStyle(doc, { name: 'Bulleted', size: 10 });
    createParagraphStyle(doc, { name: 'Numbered', size: 10 });
    applyListSettings(doc, resolveStyle(doc, 'ParagraphStyle', 'Bulleted'), {
      kind: 'bullet',
      bulletCharacter: '▪',
      indent: 12,
      bulletIndent: 12,
    });
    applyListSettings(doc, resolveStyle(doc, 'ParagraphStyle', 'Numbered'), {
      kind: 'number',
      numberStyle: 'lower-letters',
      startAt: 3,
    });
    const bullet = resolveStyle(doc, 'ParagraphStyle', 'Bulleted');
    expect(bullet.getAttribute('BulletsAndNumberingListType')).toBe('BulletList');
    expect(bullet.getElementsByTagName('BulletChar')[0]!.getAttribute('BulletCharacterValue')).toBe(
      String('▪'.codePointAt(0)),
    );
    const numbered = resolveStyle(doc, 'ParagraphStyle', 'Numbered');
    expect(numbered.getAttribute('NumberingStartAt')).toBe('3');
    expect(numbered.getElementsByTagName('NumberingFormat')[0]!.textContent).toBe('LowerLetters');
    applyListSettings(doc, numbered, { kind: 'none' });
    expect(numbered.getAttribute('BulletsAndNumberingListType')).toBe('NoList');
    expect(errorsOf(doc)).toEqual([]);
  });

  test('tab stops round-trip', () => {
    const doc = createDocument({ pageSize: 'A4' });
    createParagraphStyle(doc, { name: 'Price line' });
    const style = resolveStyle(doc, 'ParagraphStyle', 'Price line');
    setTabStops(style, [
      { position: 200, alignment: 'right', leader: '.' },
      { position: 100, alignment: 'left' },
    ]);
    const stops = readTabStops(style);
    expect(stops).toHaveLength(2);
    expect(stops[0]!.position).toBe(100); // sorted
    expect(stops[1]!.alignment).toBe('right');
    expect(stops[1]!.leader).toBe('.');
    setTabStops(style, []);
    expect(readTabStops(style)).toEqual([]);
    expect(errorsOf(doc)).toEqual([]);
  });

  test('special characters', () => {
    expect(expandSpecialCharacters('A<em-dash>B<bullet>C')).toBe('A—B•C');
    expect(expandSpecialCharacters('<unknown>')).toBe('<unknown>');
  });
});

describe('hyperlinks', () => {
  test('links text and lists the links', () => {
    const doc = createDocument({ pageSize: 'A4' });
    const frame = createTextFrame(
      doc,
      { page: 1 },
      {
        rect: { x: 20, y: 20, width: 300, height: 60 },
        text: 'Visit our shop for more, our shop is open',
        name: 'T',
      },
    );
    const story = doc.story(frame.getAttribute('ParentStory')!)!;
    const links = createHyperlink(doc, story, 'our shop', 'example.com', { all: true });
    expect(links).toHaveLength(2);
    expect(links[0]!.url).toBe('https://example.com');
    expect(readStoryPlainText(story)).toBe('Visit our shop for more, our shop is open');
    const again = IdmlDocument.fromBytes(doc.toBytes());
    expect(listHyperlinks(again)).toHaveLength(2);
    expect(again.root.getElementsByTagName('HyperlinkURLDestination')).toHaveLength(2);
    expect(errorsOf(doc)).toEqual([]);
    expect(() => createHyperlink(doc, story, 'nothing here', 'x.com')).toThrow(/not found/);
  });
});

describe('sections and page numbering', () => {
  test('roman numerals and prefixes', () => {
    expect(formatPageNumber(4, 'UpperRoman')).toBe('IV');
    expect(formatPageNumber(9, 'LowerRoman')).toBe('ix');
    expect(formatPageNumber(1, 'UpperLetters')).toBe('A');
    expect(formatPageNumber(27, 'LowerLetters')).toBe('aa');
    const doc = createDocument({ pageSize: 'A5', pages: 6 });
    setSection(doc, { startPage: 1, style: 'lower-roman', pageNumberStart: 1 });
    setSection(doc, { startPage: 3, style: 'arabic', pageNumberStart: 1 });
    const names = listPages(doc).map((p) => p.name);
    expect(names).toEqual(['i', 'ii', '1', '2', '3', '4']);
    expect(errorsOf(doc)).toEqual([]);
  });
});

describe('anchored objects', () => {
  test('anchors an item into a story', () => {
    const doc = createDocument({ pageSize: 'A4' });
    const frame = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 20, width: 300, height: 200 }, text: 'Look at this icon here', name: 'Body' },
    );
    createRectangle(
      doc,
      { page: 1 },
      { rect: { x: 250, y: 250, width: 10, height: 10 }, name: 'Icon', fill: 'Black' },
    );
    const story = doc.story(frame.getAttribute('ParentStory')!)!;
    anchorItem(doc, story, findItem(doc, 'Icon').element, { find: 'icon', position: 'inline' });
    const again = IdmlDocument.fromBytes(doc.toBytes());
    // the rectangle is no longer a page item; it lives in the story
    expect(listItems(again, { page: 1 }).map((i) => i.name)).toEqual(['Body']);
    const reloadedStory = again.story(findItem(again, 'Body').element.getAttribute('ParentStory')!)!;
    const anchored = reloadedStory.getElementsByTagName('Rectangle');
    expect(anchored).toHaveLength(1);
    expect(
      anchored[0]!.getElementsByTagName('AnchoredObjectSetting')[0]!.getAttribute('AnchoredPosition'),
    ).toBe('InlinePosition');
    expect(readStoryPlainText(reloadedStory)).toContain('Look at this');
    expect(errorsOf(doc)).toEqual([]);
  });
});

describe('table and typography tools over MCP', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-tables-'));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer(
      loadConfig({ INDESIGN_MCP_DOCUMENTS: dir, INDESIGN_MCP_DISABLE_INDESIGN: '1' }),
    ).connect(st);
    client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
  });

  test('price list with a table, list styles, tabs, links and numbering', async () => {
    const created = await call('new_document', { path: 'menu', pageSize: 'A4', pages: 2 });
    const doc = created.data!.path as string;

    const table = await call('add_table', {
      document: doc,
      page: 1,
      x: 20,
      y: 40,
      width: 170,
      data: [
        ['Item', 'Price'],
        ['Sourdough', '45 kr'],
        ['Croissant', '28 kr'],
      ],
      headerRows: 1,
      headerFill: '#eeeeee',
      alternatingFill: '#f8f8f8',
      name: 'Prices',
    });
    expect(table.isError).toBe(false);
    expect(table.data!.rows).toBe(3);

    expect(
      (await call('set_table_cells', { document: doc, frame: 'Prices', row: 3, column: 2, text: '30 kr' }))
        .isError,
    ).toBe(false);
    const read = await call('get_table', { document: doc, frame: 'Prices' });
    expect(read.text).toContain('30 kr');
    expect(
      (
        await call('edit_table_structure', {
          document: doc,
          frame: 'Prices',
          action: 'insert-rows',
          at: 4,
          count: 1,
        })
      ).data!.rows,
    ).toBe(4);
    expect(
      (await call('set_table_cells', { document: doc, frame: 'Prices', row: 4, column: 1, text: 'Rye loaf' }))
        .isError,
    ).toBe(false);
    expect(
      (
        await call('style_table', {
          document: doc,
          frame: 'Prices',
          columns: [2],
          verticalAlignment: 'center',
        })
      ).isError,
    ).toBe(false);
    expect(
      (await call('merge_table_cells', { document: doc, frame: 'Prices', row: 1, column: 1, columnSpan: 2 }))
        .isError,
    ).toBe(false);

    expect((await call('create_paragraph_style', { document: doc, name: 'Bullets', size: 10 })).isError).toBe(
      false,
    );
    expect(
      (
        await call('set_list_options', {
          document: doc,
          style: 'Bullets',
          kind: 'bullet',
          bulletCharacter: '–',
          indent: 5,
          bulletIndent: 5,
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await call('set_tab_stops', {
          document: doc,
          style: 'Bullets',
          stops: [{ position: 60, alignment: 'right', leader: '.' }],
        })
      ).data!.stops,
    ).toHaveLength(1);

    expect(
      (
        await call('add_text_frame', {
          document: doc,
          page: 2,
          x: 20,
          y: 20,
          width: 170,
          height: 60,
          text: 'Order at example.com today',
          name: 'CTA',
        })
      ).isError,
    ).toBe(false);
    const link = await call('add_hyperlink', {
      document: doc,
      item: 'CTA',
      text: 'example.com',
      url: 'https://example.com/order',
    });
    expect(link.isError).toBe(false);
    expect((await call('list_hyperlinks', { document: doc })).data!.links).toHaveLength(1);

    expect(
      (await call('set_page_numbering', { document: doc, startPage: 1, style: 'lower-roman' })).text,
    ).toContain('i, ii');
    expect((await call('insert_special_characters', { document: doc, item: 'CTA' })).isError).toBe(false);

    const v = await call('validate_document', { document: doc });
    expect(v.data!.errors).toBe(0);
    const prev = await call('preview_page', { document: doc, page: 1, width: 400, renderer: 'builtin' });
    expect(prev.isError).toBe(false);
  });
});
