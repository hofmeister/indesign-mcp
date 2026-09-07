// Regressions from the first round of real-document testing.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createTextFrame, findItem } from '../src/idml/items.ts';
import { isFacingPages, layoutMasterSpread } from '../src/idml/pages.ts';
import {
  applyObjectStyle,
  createCharacterStyle,
  createObjectStyle,
  createParagraphStyle,
  listFonts,
  resolveStyle,
} from '../src/idml/styles.ts';
import { createDocument } from '../src/idml/template.ts';
import { applyListSettings } from '../src/idml/typography.ts';
import { validateDocument } from '../src/idml/validate.ts';
import { attr, children, type Element, firstChild, getProperty } from '../src/idml/xml.ts';
import { fontCatalog } from '../src/preview/fonts.ts';
import { createServer } from '../src/server.ts';

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

function docPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'indesign-mcp-reg-')), `${name}.idml`);
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return r as { isError?: boolean; content: { type: string; text?: string }[] };
}

describe('numbers sent as strings', () => {
  test('create_paragraph_style accepts a stringified leading, and still rejects nonsense', async () => {
    const client = await connectedClient();
    const document = docPath('leading');
    expect((await call(client, 'new_document', { path: document, pageSize: 'A4' })).isError).toBeFalsy();

    // The bug: a client that sends 41 as "41" got "leading: Invalid input".
    const stringy = await call(client, 'create_paragraph_style', {
      document,
      name: 'Body',
      size: '18',
      leading: '41',
    });
    expect(stringy.isError).toBeFalsy();

    const numeric = await call(client, 'create_paragraph_style', {
      document,
      name: 'Body2',
      size: 18,
      leading: 41,
    });
    expect(numeric.isError).toBeFalsy();

    // "auto" is still a valid leading, and out-of-range values are still refused.
    expect(
      (await call(client, 'create_paragraph_style', { document, name: 'B3', leading: 'auto' })).isError,
    ).toBeFalsy();
    const tooBig = await call(client, 'create_paragraph_style', { document, name: 'B4', leading: '99999' });
    expect(tooBig.content[0]?.text ?? '').toMatch(/leading/i);
  });

  test('a style may still be named with digits', async () => {
    const client = await connectedClient();
    const document = docPath('named');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    expect((await call(client, 'create_paragraph_style', { document, name: '41' })).isError).toBeFalsy();
    const listed = await call(client, 'list', { what: 'styles', document, kind: 'paragraph' });
    expect(listed.content[0]?.text).toContain('41');
  });
});

describe('creating many at once', () => {
  test('a whole palette and type scale in one call each', async () => {
    const client = await connectedClient();
    const document = docPath('bulk');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });

    const swatches = await call(client, 'create_swatch', {
      document,
      swatches: [
        { name: 'Brand Blue', color: 'cmyk(90,60,0,0)' },
        { name: 'Sand', color: '#e8dcc8' },
        { name: 'Ink', color: 'cmyk(0,0,0,100)' },
      ],
    });
    expect(swatches.isError).toBeFalsy();
    expect(swatches.content[0]?.text ?? '').toContain('Created 3 swatches');

    const styles = await call(client, 'create_paragraph_style', {
      document,
      styles: [
        { name: 'Headline', size: 28, leading: 30, color: 'Brand Blue' },
        { name: 'Body', size: 10, leading: 13 },
        { name: 'Caption', size: 8, color: 'Sand' },
      ],
    });
    expect(styles.isError).toBeFalsy();
    expect(styles.content[0]?.text ?? '').toContain('Created 3 paragraph styles: Headline, Body, Caption');

    const listed = await call(client, 'list', { what: 'styles', document, kind: 'paragraph' });
    for (const name of ['Headline', 'Body', 'Caption']) expect(listed.content[0]?.text).toContain(name);
  });

  test('the single-item form still works', async () => {
    const client = await connectedClient();
    const document = docPath('single');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    const swatch = await call(client, 'create_swatch', { document, name: 'Accent', color: '#ff6600' });
    expect(swatch.content[0]?.text ?? '').toBe('Created swatch "Accent" (#ff6600).');
    const style = await call(client, 'create_paragraph_style', { document, name: 'Quote', size: 12 });
    expect(style.content[0]?.text ?? '').toBe('Created paragraph style "Quote".');
  });

  test('one bad entry creates nothing and leaves no half-built document behind', async () => {
    const client = await connectedClient();
    const document = docPath('atomic');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'create_paragraph_style', { document, name: 'Body', size: 10 });

    // "Body" already exists, so the second entry fails after the first was built in memory.
    const r = await call(client, 'create_paragraph_style', {
      document,
      styles: [
        { name: 'Fresh One', size: 9 },
        { name: 'Body', size: 9 },
        { name: 'Fresh Two', size: 9 },
      ],
    });
    expect(r.isError).toBeTruthy();
    const message = r.content.map((c) => c.text).join('');
    expect(message).toContain('already exists');
    expect(message).toContain('number 2 of 3');
    expect(message).toContain('Nothing was created');

    // Neither the entry before the failure nor the one after it may survive, in this call or a later one.
    const listed = await call(client, 'list', { what: 'styles', document, kind: 'paragraph' });
    expect(listed.content[0]?.text).not.toContain('Fresh One');
    expect(listed.content[0]?.text).not.toContain('Fresh Two');
  });

  test('the two forms may not be mixed, and one of them is required', async () => {
    const client = await connectedClient();
    const document = docPath('forms');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    const both = await call(client, 'create_swatch', {
      document,
      name: 'X',
      swatches: [{ name: 'Y', color: '#000000' }],
    });
    expect(both.isError).toBeTruthy();
    expect(both.content.map((c) => c.text).join('')).toContain('not both');

    const empty = await call(client, 'create_paragraph_style', { document, styles: [] });
    expect(empty.isError).toBeTruthy();

    const neither = await call(client, 'create_paragraph_style', { document });
    expect(neither.isError).toBeTruthy();
    expect(neither.content.map((c) => c.text).join('')).toContain('"styles" list');
  });

  test('a list sent as JSON text is still understood', async () => {
    const client = await connectedClient();
    const document = docPath('stringified');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    const r = await call(client, 'create_swatch', {
      document,
      swatches: JSON.stringify([{ name: 'Via String', color: '#123456' }]),
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text ?? '').toContain('Via String');
  });
});

describe('refusing an option says where it belongs', () => {
  test('a formatting key sent to apply_paragraph_style points at update_style and format_text', async () => {
    const client = await connectedClient();
    const document = docPath('keys');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'create_paragraph_style', { document, name: 'Running head', size: 8 });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      name: 'Head',
      text: 'Chapter one',
      x: 20,
      y: 15,
      width: 170,
      height: 6,
    });
    const r = await call(client, 'apply_paragraph_style', {
      document,
      item: 'Head',
      style: 'Running head',
      alignment: 'right',
    });
    expect(r.isError).toBeTruthy();
    const message = r.content.map((c) => c.text).join('');
    expect(message).toContain('Unknown option "alignment"');
    expect(message).toContain('This tool takes: document, item, page, style, paragraphs, containing.');
    expect(message).toContain('update_style');
    expect(message).toContain('format_text');
  });

  test('a near miss is offered as a correction', async () => {
    const client = await connectedClient();
    const document = docPath('typo');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    const r = await call(client, 'add_text_frame', {
      document,
      page: 1,
      text: 'x',
      x: 10,
      y: 10,
      widht: 50,
      height: 20,
    });
    expect(r.isError).toBeTruthy();
    expect(r.content.map((c) => c.text).join('')).toContain('Did you mean "width"?');
  });
});

describe('master pages', () => {
  test('an item on a master reads back at the coordinates it was placed with', async () => {
    const client = await connectedClient();
    const document = docPath('mastercoords');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 2 });
    const added = await call(client, 'add_text_frame', {
      document,
      master: 'A-Master',
      name: 'Folio',
      text: 'p',
      x: 18,
      y: 278,
      width: 20,
      height: 6,
    });
    // Used to report the spread-relative position (-87mm, 129.5mm) for the same placement.
    expect(added.content[0]?.text ?? '').toContain('18mm, 278mm');
    const listed = await call(client, 'list', { what: 'items', document, includeMasters: true });
    expect(listed.content[0]?.text ?? '').toContain('18mm, 278mm');
  });

  test('a master item hidden under a page item is reported by preflight and preview', async () => {
    const client = await connectedClient();
    const document = docPath('covered');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 3 });
    await call(client, 'add_text_frame', {
      document,
      master: 'A-Master',
      name: 'Folio',
      text: 'Acme',
      x: 18,
      y: 278,
      width: 60,
      height: 6,
    });
    // Page 1: a filled full-page rectangle swallows it.
    await call(client, 'add_shape', {
      document,
      shape: 'rectangle',
      page: 1,
      name: 'White box',
      x: 0,
      y: 0,
      width: 210,
      height: 297,
      fill: 'Paper',
    });
    // Page 2: a panel that stops short of the folio hides nothing.
    await call(client, 'add_shape', {
      document,
      shape: 'rectangle',
      page: 2,
      name: 'Half panel',
      x: 0,
      y: 0,
      width: 210,
      height: 150,
      fill: 'Paper',
    });
    // Page 3: a frame with no fill covers the area but hides nothing.
    await call(client, 'add_text_frame', {
      document,
      page: 3,
      name: 'Clear frame',
      text: 'hi',
      x: 0,
      y: 0,
      width: 210,
      height: 297,
    });

    const report = (await call(client, 'preflight_document', { document })).content[0]?.text ?? '';
    expect(report).toContain('"Folio" from master A-Master is completely covered on page 1 by "White box"');
    expect(report).not.toContain('page 2');
    expect(report).not.toContain('Clear frame" is completely covered');
    expect(report).toContain('override_master_item');

    const preview = await call(client, 'preview', {
      what: 'page',
      document,
      page: 1,
      renderer: 'builtin',
      width: 400,
    });
    const previewText = preview.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    expect(previewText).toContain('is hidden behind "White box"');

    const quiet = await call(client, 'preview', {
      what: 'page',
      document,
      page: 2,
      renderer: 'builtin',
      width: 400,
    });
    expect(
      quiet.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n'),
    ).not.toContain('is hidden behind');
  });

  test('overriding the item onto the page settles it', async () => {
    const client = await connectedClient();
    const document = docPath('override');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 1 });
    await call(client, 'add_text_frame', {
      document,
      master: 'A-Master',
      name: 'Folio',
      text: 'Acme',
      x: 18,
      y: 278,
      width: 60,
      height: 6,
    });
    await call(client, 'add_shape', {
      document,
      shape: 'rectangle',
      page: 1,
      name: 'White box',
      x: 0,
      y: 0,
      width: 210,
      height: 297,
      fill: 'Paper',
    });
    const before = (await call(client, 'preflight_document', { document })).content[0]?.text ?? '';
    expect(before).toContain('completely covered');

    await call(client, 'override_master_item', { document, page: 1, item: 'Folio' });
    const after = (await call(client, 'preflight_document', { document })).content[0]?.text ?? '';
    expect(after).not.toContain('completely covered');
  });
});

describe('preflight', () => {
  test('a frame holding a table is not reported as empty', async () => {
    const client = await connectedClient();
    const document = docPath('table');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      name: 'S5-tabel',
      x: 20,
      y: 20,
      width: 150,
      height: 80,
    });
    await call(client, 'add_table', { document, frame: 'S5-tabel', rows: 8, columns: 4 });

    const report = await call(client, 'preflight_document', { document });
    expect(report.isError).toBeFalsy();
    expect(report.content[0]?.text ?? '').not.toContain('S5-tabel" is empty');
  });

  test('page furniture copied onto every page is reported, and a master fixes it', async () => {
    const client = await connectedClient();
    const document = docPath('furniture');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 4 });
    for (const page of [1, 2, 3, 4]) {
      // Body copy: different prose on every page, so it must not look repeated.
      await call(client, 'add_text_frame', {
        document,
        page,
        name: `Body ${page}`,
        text: `Chapter text for page ${page}, quite different prose each time.`,
        x: 20,
        y: 60,
        width: 170,
        height: 150,
      });
      // A folio: same strip every page, differing only by the number.
      await call(client, 'add_text_frame', {
        document,
        page,
        name: `Footer ${page}`,
        text: `Acme Report — page ${page} of 4`,
        x: 20,
        y: 275,
        width: 170,
        height: 8,
      });
    }
    const before = (await call(client, 'preflight_document', { document })).content[0]?.text ?? '';
    expect(before).toContain('"Footer 1" is repeated in the same place on 4 pages');
    expect(before).toContain('master page');
    expect(before).not.toContain('"Body 1" is repeated');

    // The same layout done properly: the folio lives on the master, once.
    const fixed = docPath('furniture-fixed');
    await call(client, 'new_document', { path: fixed, pageSize: 'A4', pages: 4 });
    await call(client, 'edit_layers', { document: fixed, op: 'create', name: 'Text' });
    await call(client, 'add_text_frame', {
      document: fixed,
      master: 'A-Master',
      name: 'Footer',
      text: 'Acme Report',
      x: 20,
      y: 275,
      width: 170,
      height: 8,
    });
    for (const page of [1, 2, 3, 4]) {
      await call(client, 'add_text_frame', {
        document: fixed,
        page,
        layer: 'Text',
        name: `Body ${page}`,
        text: `Chapter text for page ${page}, quite different prose each time.`,
        x: 20,
        y: 60,
        width: 170,
        height: 150,
      });
    }
    const after = (await call(client, 'preflight_document', { document: fixed })).content[0]?.text ?? '';
    expect(after).not.toContain('is repeated in the same place');
    expect(after).not.toContain('Everything is on one layer');
  });

  test('two pages is already enough to ask for a master', async () => {
    const client = await connectedClient();
    const document = docPath('two-pages');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 2 });
    for (const page of [1, 2]) {
      await call(client, 'add_text_frame', {
        document,
        page,
        name: `Footer ${page}`,
        text: `Acme Report — page ${page}`,
        x: 20,
        y: 275,
        width: 170,
        height: 8,
      });
    }
    const report = (await call(client, 'preflight_document', { document })).content[0]?.text ?? '';
    // A two-page draft is usually the start of a longer document, so flag it now.
    expect(report).toContain('"Footer 1" is repeated in the same place on 2 pages');
    expect(report).toContain('pages you add later then inherit it automatically');
  });

  test('a single page never looks repeated', async () => {
    const client = await connectedClient();
    const document = docPath('one-page');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 1 });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      name: 'Footer',
      text: 'Acme Report',
      x: 20,
      y: 275,
      width: 170,
      height: 8,
    });
    const report = (await call(client, 'preflight_document', { document })).content[0]?.text ?? '';
    expect(report).not.toContain('is repeated in the same place');
  });

  test('a document left on a single layer is reported', async () => {
    const client = await connectedClient();
    const document = docPath('layers');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 2 });
    const before = (await call(client, 'preflight_document', { document })).content[0]?.text ?? '';
    expect(before).toContain('Everything is on one layer');
    // The advice has to be runnable as written.
    expect(before).toContain('edit_layers (op "create")');
    await call(client, 'edit_layers', { document, op: 'create', name: 'Images' });
    const after = (await call(client, 'preflight_document', { document })).content[0]?.text ?? '';
    expect(after).not.toContain('Everything is on one layer');
  });

  test('the font check survives a font whose postscript name is not a string', async () => {
    const client = await connectedClient();
    const document = docPath('fonts');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    const report = await call(client, 'preflight_document', { document });
    expect(report.isError).toBeFalsy();
    expect(report.content[0]?.text ?? '').not.toContain('toLowerCase is not a function');
  });
});

describe('page number markers', () => {
  test('the marker takes the formatting of the text it joins, not [Basic Paragraph]', async () => {
    const client = await connectedClient();
    const document = docPath('footer');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'create_paragraph_style', {
      document,
      name: 'Footer',
      font: 'Liberation Sans',
      size: 9,
    });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      name: 'footer',
      x: 20,
      y: 270,
      width: 100,
      height: 10,
      text: 'Page ',
      paragraphStyle: 'Footer',
    });
    await call(client, 'insert_page_number', { document, item: 'footer' });

    const items = await call(client, 'list', { what: 'items', document, page: 1 });
    expect(items.isError).toBeFalsy();

    const { readFileSync } = await import('node:fs');
    const { unzipSync, strFromU8 } = await import('fflate');
    const zip = unzipSync(new Uint8Array(readFileSync(document)));
    const storyXml = Object.entries(zip)
      .filter(([n]) => n.startsWith('Stories/'))
      .map(([, v]) => strFromU8(v))
      .join('\n');
    // The marker paragraph must not have fallen back to the template default.
    const markerParagraph = storyXml.slice(0, storyXml.indexOf('ACE'));
    expect(markerParagraph).toContain('Footer');
  });
});

describe('nested values sent as JSON text', () => {
  test('a stringified data array is understood, and a bad escape is named', async () => {
    const client = await connectedClient();
    const document = docPath('json');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      name: 'T',
      x: 20,
      y: 20,
      width: 150,
      height: 60,
    });

    const stringified = await call(client, 'add_table', {
      document,
      frame: 'T',
      data: '[["a","b"],["c","d"]]',
    });
    expect(stringified.isError).toBeFalsy();

    // The bug: a malformed escape inside a nested string was reported as
    // "data: Invalid input: expected array, received string", pointing at the wrong level.
    const badEscape = await call(client, 'add_table', {
      document,
      frame: 'T',
      data: '[["a","b\\ú"]]',
    });
    const text = badEscape.content[0]?.text ?? '';
    expect(text).toMatch(/does not parse/i);
    expect(text).not.toMatch(/expected array, received string/i);
  });
});

describe('preflight colour noise', () => {
  test('only swatches the document actually uses are judged', async () => {
    const client = await connectedClient();
    const document = docPath('swatches');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'create_swatch', { document, name: 'Unused CMYK', color: 'cmyk(0,100,0,0)' });
    await call(client, 'create_swatch', { document, name: 'Used CMYK', color: 'cmyk(100,0,0,0)' });
    await call(client, 'add_shape', {
      shape: 'rectangle',
      document,
      page: 1,
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      fill: 'Used CMYK',
    });

    const report = await call(client, 'preflight_document', { document, intent: 'screen' });
    const text = report.content[0]?.text ?? '';
    expect(text).toContain('Used CMYK');
    expect(text).not.toContain('Unused CMYK');
  });
});

describe('contact sheet', () => {
  test('each page tile gets its own element ids', async () => {
    const { loadConfig } = await import('../src/config.ts');
    const { ToolContext } = await import('../src/tools/context.ts');
    const { renderPageSvg } = await import('../src/preview/svg.ts');

    const ctx = new ToolContext(loadConfig({ INDESIGN_MCP_DOCUMENTS: tmpdir() }));
    const client = await connectedClient();
    const document = docPath('sheet');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 2 });
    for (const page of [1, 2])
      await call(client, 'add_text_frame', {
        document,
        page,
        name: `H${page}`,
        x: 20,
        y: 20,
        width: 150,
        height: 40,
        text: page === 1 ? 'Alpha heading' : 'Zulu heading',
      });

    const doc = ctx.open(document);
    const ids = (svg: string) => new Set([...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!));
    const a = ids(renderPageSvg(doc, 1, { idPrefix: 'p1-' }).svg);
    const b = ids(renderPageSvg(doc, 2, { idPrefix: 'p2-' }).svg);

    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBeGreaterThan(0);
    // The bug: without a per-tile prefix both pages emitted gl0, gl1, … and the second page's
    // glyphs resolved to the first page's outlines once the tiles shared one SVG.
    for (const id of a) expect(b.has(id)).toBe(false);
  });
});

describe('master page transforms', () => {
  test('every page inherits its master unshifted', async () => {
    const client = await connectedClient();
    const document = docPath('master');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 4 });
    await call(client, 'edit_pages', { op: 'add', document, count: 2 });
    await call(client, 'edit_pages', { op: 'duplicate', document, page: 1 });

    const { readFileSync } = await import('node:fs');
    const { strFromU8, unzipSync } = await import('fflate');
    const zip = unzipSync(new Uint8Array(readFileSync(document)));
    const transforms: string[] = [];
    for (const [name, bytes] of Object.entries(zip)) {
      if (!/Spread/.test(name)) continue;
      for (const m of strFromU8(bytes).matchAll(/MasterPageTransform="([^"]*)"/g)) transforms.push(m[1]!);
    }
    expect(transforms.length).toBeGreaterThan(0);
    // A stale transform here is honoured by InDesign but ignored by the built-in renderer, so the
    // two disagree: master items come out offset only in the InDesign render.
    for (const t of transforms) expect(t).toBe('1 0 0 1 0 0');
  });

  test('the bundled blank template carries no page offset', async () => {
    const { loadBlankTemplateBytes } = await import('../src/idml/template.ts');
    const { strFromU8, unzipSync } = await import('fflate');
    const zip = unzipSync(loadBlankTemplateBytes());
    for (const [name, bytes] of Object.entries(zip)) {
      if (!/Spread/.test(name)) continue;
      for (const m of strFromU8(bytes).matchAll(/MasterPageTransform="([^"]*)"/g))
        expect(m[1]).toBe('1 0 0 1 0 0');
    }
  });
});

describe('named inline colours', () => {
  test('"as <name>" names the swatch, and reuses it the second time', async () => {
    const client = await connectedClient();
    const document = docPath('colour');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    for (const y of [10, 80])
      await call(client, 'add_shape', {
        shape: 'rectangle',
        document,
        page: 1,
        x: 10,
        y,
        width: 50,
        height: 50,
        fill: '#14342b as Brand Green',
      });

    const swatches = await call(client, 'list', { what: 'swatches', document });
    const text = swatches.content[0]?.text ?? '';
    expect(text).toContain('Brand Green');
    // The auto-generated name must not appear alongside it, and the second use must not have
    // created a duplicate or failed with "a swatch named ... already exists".
    expect(text).not.toContain('R=20 G=52 B=43');
    expect(text.match(/Brand Green/g)?.length).toBe(1);
  });
});

describe('fonts reported as used', () => {
  test('a style nobody applies does not drag its font into the report', async () => {
    const client = await connectedClient();
    const document = docPath('fonts2');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'create_paragraph_style', {
      document,
      name: 'Body',
      font: 'Liberation Sans',
      size: 10,
    });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      name: 'H',
      x: 20,
      y: 20,
      width: 100,
      height: 20,
      text: 'Hi',
      paragraphStyle: 'Body',
    });

    const report = await call(client, 'preflight_document', { document });
    // The template's unused [Basic Paragraph] is Minion Pro; nothing in this document asks for it.
    expect(report.content[0]?.text ?? '').not.toContain('Minion Pro');
  });
});

describe('tool descriptions', () => {
  test('every tool a description points at exists', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    expect(names.size).toBeGreaterThan(50);
    // The subjects `list` accepts are not tools, but read like tool names.
    const listSubjects = new Set(
      (
        tools.find((t) => t.name === 'list')?.inputSchema as
          | { properties?: { what?: { enum?: string[] } } }
          | undefined
      )?.properties?.what?.enum ?? [],
    );

    const missing: string[] = [];
    for (const tool of tools) {
      const text = [tool.description ?? '', JSON.stringify(tool.inputSchema ?? {})].join(' ');
      // Tool names are snake_case; only check words that look like a reference to one.
      for (const m of text.matchAll(/`?\b([a-z]+(?:_[a-z]+){1,3})\b`?/g)) {
        const word = m[1]!;
        if (names.has(word) || listSubjects.has(word)) continue;
        if (
          !/^(add|create|set|get|list|new|open|apply|insert|delete|remove|move|export|preview|describe|validate|preflight|package|place|edit|update|find|format|import|copy|duplicate|resize|rotate|group|ungroup|thread|anchor|override|relink|embed|unembed|step|style|merge|reorder|rename|arrange|align|fit|data)_/.test(
            word,
          )
        )
          continue;
        missing.push(`${tool.name}: ${word}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('second round of real-document testing', () => {
  test('an object style leaves paragraphs that already have a style alone', async () => {
    const client = await connectedClient();
    const document = docPath('objectstyle');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'create_paragraph_style', { document, name: 'Heading 2', size: 16 });
    await call(client, 'create_paragraph_style', { document, name: 'Body First', size: 10 });
    await call(client, 'create_object_style', { document, name: 'Panel', paragraphStyle: 'Body First' });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      name: 'Panel Frame',
      x: 20,
      y: 20,
      width: 120,
      height: 60,
      paragraphs: [
        { text: 'A heading', style: 'Heading 2' },
        { text: 'Some body copy.', style: 'Body First' },
      ],
    });
    await call(client, 'apply_object_style', { document, item: 'Panel Frame', style: 'Panel' });

    const text = await call(client, 'get_text', { document, item: 'Panel Frame' });
    expect(text.content[0]?.text ?? '').toContain('Heading 2');
  });

  test('a numbered list keeps textAfter alongside numberFormat, and a bullet keeps its font', () => {
    const doc = createDocument({ pageSize: 'A4', pages: 1 });
    const numbered = createParagraphStyle(doc, { name: 'Numbered', size: 10 });
    applyListSettings(doc, resolveStyle(doc, 'ParagraphStyle', 'Numbered'), {
      kind: 'number',
      numberFormat: '^#.',
      textAfter: '^t',
    });
    expect(numbered.name).toBe('Numbered');
    const style = resolveStyle(doc, 'ParagraphStyle', 'Numbered');
    expect(attr(style, 'NumberingExpression')).toBe('^#.^t');

    createParagraphStyle(doc, { name: 'Bulleted', size: 10 });
    const bulleted = resolveStyle(doc, 'ParagraphStyle', 'Bulleted');
    applyListSettings(doc, bulleted, { kind: 'bullet', bulletCharacter: '▪', font: 'Helvetica Neue' });
    // InDesign ignores an object reference here; the font has to be a plain string plus a style.
    expect(getProperty(bulleted, 'BulletsFont')).toEqual({ type: 'string', value: 'Helvetica Neue' });
    expect(getProperty(bulleted, 'BulletsFontStyle')?.value).toBe('Regular');
  });

  test('a bullet character the font has no glyph for is reported', async () => {
    const client = await connectedClient();
    const document = docPath('bulletfont');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    // A family no computer has: it falls back to a bundled face, which carries no symbols.
    await call(client, 'create_paragraph_style', {
      document,
      name: 'B',
      font: 'Nonexistent Grotesk',
      size: 10,
    });
    const r = await call(client, 'set_list_options', {
      document,
      style: 'B',
      kind: 'bullet',
      bulletCharacter: '▪',
    });
    // InDesign draws the bullet in the list's own font and shows a box when the glyph is missing.
    const alternative = fontCatalog().faceWithGlyph(0x25aa)?.info.family;
    const text = r.content[0]?.text ?? '';
    if (alternative) expect(text).toContain(alternative);
    else expect(text).toContain('missing-glyph');

    const plain = await call(client, 'set_list_options', {
      document,
      style: 'B',
      kind: 'bullet',
      bulletCharacter: '•',
    });
    expect(plain.content[0]?.text ?? '').not.toContain('Note:');
  });

  test('insert_page_number can replace text, like insert_text_variable', async () => {
    const client = await connectedClient();
    const document = docPath('folio');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      name: 'Folio',
      x: 20,
      y: 20,
      width: 120,
      height: 20,
      text: 'Page # of 4',
    });
    const r = await call(client, 'insert_page_number', {
      document,
      item: 'Folio',
      replaceText: '#',
    });
    expect(r.isError).toBeFalsy();
    const text = await call(client, 'get_text', { document, item: 'Folio' });
    expect(text.content[0]?.text ?? '').toContain('of 4');
  });

  test('a variable put in beside a page-number marker leaves the marker alone', async () => {
    const client = await connectedClient();
    const document = docPath('folio2');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 2 });
    await call(client, 'create_text_variable', { document, name: 'Last Page', kind: 'last-page-number' });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      name: 'Folio',
      x: 20,
      y: 275,
      width: 80,
      height: 10,
      text: 'Page # of L',
    });
    await call(client, 'insert_page_number', { document, item: 'Folio', replaceText: '#' });
    await call(client, 'insert_text_variable', {
      document,
      item: 'Folio',
      variable: 'Last Page',
      replaceText: 'L',
    });

    // Rebuilding the <Content> from its text used to throw the marker away.
    const items = await call(client, 'list', { what: 'items', document, page: 1 });
    expect(items.content[0]?.text ?? '').toContain('Page # of <Last Page>');
  });

  test('a frame holding only a text variable is not listed as empty', async () => {
    const client = await connectedClient();
    const document = docPath('variable');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'create_text_variable', {
      document,
      name: 'Running Head',
      kind: 'last-page-number',
    });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      name: 'Head',
      x: 20,
      y: 20,
      width: 120,
      height: 20,
      text: '',
    });
    await call(client, 'insert_text_variable', { document, item: 'Head', variable: 'Running Head' });

    const items = await call(client, 'list', { what: 'items', document, page: 1 });
    expect(items.content[0]?.text ?? '').toContain('<Running Head>');
  });
});

describe('third round: styles and references', () => {
  test('basedOn is written the way InDesign resolves it', () => {
    const doc = createDocument({ pageSize: 'A4', pages: 1 });
    createParagraphStyle(doc, { name: 'Parent', font: 'Helvetica Neue', size: 11 });
    createParagraphStyle(doc, { name: 'Child', basedOn: 'Parent' });
    createCharacterStyle(doc, { name: 'CharParent', fontStyle: 'Bold' });
    createCharacterStyle(doc, { name: 'CharChild', basedOn: 'CharParent' });

    // InDesign writes a custom parent as an object reference; the bare name it cannot resolve, and
    // the child then silently inherits nothing.
    const child = resolveStyle(doc, 'ParagraphStyle', 'Child');
    expect(getProperty(child, 'BasedOn')).toEqual({ type: 'object', value: 'ParagraphStyle/Parent' });
    const charChild = resolveStyle(doc, 'CharacterStyle', 'CharChild');
    expect(getProperty(charChild, 'BasedOn')).toEqual({
      type: 'object',
      value: 'CharacterStyle/CharParent',
    });
    // A built-in parent keeps the $ID form.
    const parent = resolveStyle(doc, 'ParagraphStyle', 'Parent');
    expect(getProperty(parent, 'BasedOn')?.type).toBe('string');
  });

  test('a set of styles may point basedOn and nextStyle at each other, or at itself', async () => {
    const client = await connectedClient();
    const document = docPath('styleset');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    const r = await call(client, 'create_paragraph_style', {
      document,
      styles: [
        // Body comes after the style based on it, and points nextStyle at itself.
        { name: 'Intro', basedOn: 'Body', nextStyle: 'Body' },
        { name: 'Body', size: 10, nextStyle: 'Body' },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text ?? '').toContain('Body');
  });

  test('a facing-pages reference keeps its setup, and a single-sided one moves master items', () => {
    const reference = createDocument({ pageSize: 'A5', pages: 2, facingPages: true });
    const master = reference.masterSpreads()[0]!;
    // A running head on the first (left) master page sits at negative spread coordinates.
    createTextFrame(
      reference,
      { master: 'A-Master' },
      { rect: { x: 10, y: 10, width: 60, height: 6 }, name: 'Running Head', text: 'Head' },
    );
    expect(children(master, 'Page').length).toBe(2);
    const bytes = reference.toBytes();

    // Started from the reference: the facing-pages setup comes along.
    const facing = createDocument({ templateBytes: bytes, pages: 2 });
    expect(isFacingPages(facing)).toBe(true);

    // Forced single-sided: the master loses a page, and its items move with the page they are on.
    const single = createDocument({ templateBytes: bytes, pages: 2, facingPages: false });
    const singleMaster = single.masterSpreads()[0]!;
    expect(children(singleMaster, 'Page').length).toBe(1);
    const item = findItem(single, 'Running Head');
    expect(item.info.bounds?.x).toBeCloseTo(10, 1);
    expect(item.info.bounds?.y).toBeCloseTo(10, 1);
  });

  test('only the items of the page that went away are counted as orphaned', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 2, facingPages: true });
    for (const side of ['left', 'right'] as const)
      createTextFrame(
        doc,
        { master: 'A-Master', masterPage: side },
        { rect: { x: 10, y: 10, width: 60, height: 6 }, name: `Head ${side}`, text: side },
      );
    const master = doc.masterSpreads()[0]!;
    // An item's position is in its path, not its transform: counting transforms called every item
    // an orphan. One page goes, so one of the two frames is left beside the paper.
    const { orphaned } = layoutMasterSpread(master, { facing: false, width: 419.5, height: 595.3 });
    expect(orphaned).toBe(1);
  });
});

describe('third round: the smaller edges', () => {
  test('a document declares the fonts its styles use', () => {
    const doc = createDocument({ pageSize: 'A4', pages: 1 });
    createParagraphStyle(doc, { name: 'Body', font: 'Helvetica Neue', size: 10 });
    createParagraphStyle(doc, { name: 'Head', font: 'Helvetica Neue', fontStyle: 'Bold', size: 20 });
    // Everything that reads the file rather than laying it out works from Fonts.xml.
    const family = listFonts(doc).find((f) => f.family === 'Helvetica Neue');
    expect(family?.styles).toEqual(expect.arrayContaining(['Regular', 'Bold']));
    expect(validateDocument(doc).filter((i) => i.level === 'error')).toEqual([]);
  });

  test('an item on a two-page master says it only shows on one side', async () => {
    const client = await connectedClient();
    const document = docPath('facing');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 2, facingPages: true });
    const r = await call(client, 'add_text_frame', {
      document,
      master: 'A-Master',
      name: 'Running Head',
      x: 18,
      y: 10,
      width: 80,
      height: 6,
      text: 'Head',
    });
    expect(r.content[0]?.text ?? '').toContain('went on the left one');

    // A single-page master says nothing of the sort.
    const single = docPath('single');
    await call(client, 'new_document', { path: single, pageSize: 'A4', pages: 2 });
    const q = await call(client, 'add_text_frame', {
      document: single,
      master: 'A-Master',
      name: 'Running Head',
      x: 18,
      y: 10,
      width: 80,
      height: 6,
      text: 'Head',
    });
    expect(q.content[0]?.text ?? '').not.toContain('went on the left one');
  });

  test('listing styles does not dump every InDesign default', async () => {
    const client = await connectedClient();
    const document = docPath('stylelist');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'create_paragraph_style', { document, name: 'Body', size: 10 });
    const r = (await call(client, 'list', { what: 'styles', document, kind: 'paragraph' })) as {
      structuredContent?: unknown;
    };
    const json = JSON.stringify(r.structuredContent ?? {});
    expect(json).toContain('Body');
    expect(json).not.toContain('RubyParentSpacing');
  });
});

describe('object styles based on other object styles', () => {
  test('the parent is referenced, and applying the child brings the parent along', () => {
    const doc = createDocument({ pageSize: 'A4', pages: 1 });
    createParagraphStyle(doc, { name: 'Panel Body', font: 'Helvetica Neue', size: 10 });
    createObjectStyle(doc, {
      name: 'Panel',
      fill: 'cmyk(35,5,45,0) as Moss',
      inset: 8,
      paragraphStyle: 'Panel Body',
    });
    createObjectStyle(doc, { name: 'Note', basedOn: 'Panel', fill: 'cmyk(25,0,95,0) as Citrus' });

    const note = resolveStyle(doc, 'ObjectStyle', 'Note');
    expect(getProperty(note, 'BasedOn')).toEqual({ type: 'object', value: 'ObjectStyle/Panel' });

    const frame = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 20, width: 80, height: 40 }, name: 'Note Frame', text: 'Hello' },
    );
    applyObjectStyle(doc, frame, 'Note');
    // Its own fill wins; the inset and paragraph style come from the style it is based on.
    expect(attr(frame, 'FillColor')).toBe('Color/Citrus');
    const inset = firstChild(firstChild(frame, 'TextFramePreference'), 'Properties');
    expect(inset?.textContent).toContain('8');
    const story = doc.story(attr(frame, 'ParentStory') ?? '')!;
    const psr = story.getElementsByTagName('ParagraphStyleRange')[0] as unknown as Element;
    expect(attr(psr, 'AppliedParagraphStyle')).toBe('ParagraphStyle/Panel Body');
  });
});

describe('master pages have sides', () => {
  test('an item can be put on either page of a facing master, and is measured against it', async () => {
    const client = await connectedClient();
    const document = docPath('mastersides');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 2, facingPages: true });
    for (const side of ['left', 'right'] as const) {
      const r = await call(client, 'add_text_frame', {
        document,
        master: 'A-Master',
        masterPage: side,
        name: `Head ${side}`,
        x: 18,
        y: 10,
        width: 80,
        height: 6,
        text: 'Head',
      });
      // Measured against the page it went on: neither is "off the page" or "on the pasteboard".
      expect(r.content[0]?.text ?? '').not.toContain('pasteboard');
      expect(r.content[0]?.text ?? '').toContain(`went on the ${side} one`);
    }

    const items = await call(client, 'list', { what: 'items', document, includeMasters: true });
    const text = items.content[0]?.text ?? '';
    // Both report the same page-relative position, on their own side.
    expect(text).toContain('Head left');
    expect(text).toContain('Head right');
    expect((text.match(/18mm, 10mm/g) ?? []).length).toBe(2);
  });

  test('a master page that does not exist is refused', async () => {
    const client = await connectedClient();
    const document = docPath('masterpage3');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 2, facingPages: true });
    const r = await call(client, 'add_shape', {
      document,
      master: 'A-Master',
      masterPage: 3,
      shape: 'rectangle',
      x: 10,
      y: 10,
      width: 20,
      height: 20,
    });
    expect(r.content[0]?.text ?? '').toContain('no page 3');
  });
});

describe('master pages, in full', () => {
  test('create, rename, re-page, base on another, delete', async () => {
    const client = await connectedClient();
    const document = docPath('masters');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 4, facingPages: true });

    // A gatefold master: three pages in one spread.
    const made = await call(client, 'edit_masters', {
      op: 'create',
      document,
      prefix: 'G',
      name: 'Gatefold',
      pages: 3,
      keepItems: false,
    });
    expect(made.content[0]?.text ?? '').toContain('3 page(s)');

    // Its third page can be addressed like any other.
    const onThird = await call(client, 'add_shape', {
      document,
      master: 'G-Gatefold',
      masterPage: 3,
      shape: 'rectangle',
      name: 'Flap',
      x: 10,
      y: 10,
      width: 40,
      height: 20,
      fill: 'Black',
    });
    expect(onThird.content[0]?.text ?? '').not.toContain('pasteboard');
    const items = await call(client, 'list', { what: 'items', document, includeMasters: true });
    expect(items.content[0]?.text ?? '').toContain('[master G-Gatefold page 3]');

    await call(client, 'edit_masters', { op: 'rename', document, master: 'G-Gatefold', name: 'Foldout' });
    const renamed = await call(client, 'list', { what: 'masters', document });
    expect(renamed.content[0]?.text ?? '').toContain('G-Foldout');

    await call(client, 'edit_masters', { op: 'pages', document, master: 'G-Foldout', count: 2 });
    const repaged = await call(client, 'list', { what: 'masters', document });
    expect(repaged.content[0]?.text ?? '').toMatch(/G-Foldout[^\n]*2 page/);

    // Based on another master, the way InDesign's "Based on Master" works.
    const parented = await call(client, 'edit_masters', {
      op: 'parent',
      document,
      master: 'G-Foldout',
      parent: 'A-Master',
    });
    expect(parented.isError).toBeFalsy();
    const loop = await call(client, 'edit_masters', {
      op: 'parent',
      document,
      master: 'A-Master',
      parent: 'G-Foldout',
    });
    expect(loop.content[0]?.text ?? '').toContain('on each other');

    // Deleting sends the pages that used it to another master.
    await call(client, 'apply_master', { document, master: 'G-Foldout', pages: [2] });
    const deleted = await call(client, 'edit_masters', {
      op: 'delete',
      document,
      master: 'G-Foldout',
      replaceWith: 'A-Master',
    });
    expect(deleted.content[0]?.text ?? '').toContain('1 page(s)');
    const pages = await call(client, 'list', { what: 'pages', document });
    expect(pages.content[0]?.text ?? '').not.toContain('G-Foldout');

    const validated = await call(client, 'validate_document', { document });
    expect(validated.content[0]?.text ?? '').toContain('No problems found');
  });

  test('the last master cannot be deleted', async () => {
    const client = await connectedClient();
    const document = docPath('lastmaster');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    const r = await call(client, 'edit_masters', { op: 'delete', document, master: 'A-Master' });
    expect(r.content[0]?.text ?? '').toContain('at least one master');
  });
});

describe('several masters in one document', () => {
  test('each master can be built, applied and listed with the pages that use it', async () => {
    const client = await connectedClient();
    const document = docPath('manymasters');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 6 });

    // Three masters, each with its own furniture.
    for (const [prefix, name, y] of [
      ['B', 'Chapter', 20],
      ['C', 'Gallery', 30],
      ['D', 'Back', 40],
    ] as const) {
      await call(client, 'edit_masters', {
        op: 'create',
        document,
        prefix,
        name,
        keepItems: false,
      });
      await call(client, 'add_text_frame', {
        document,
        master: `${prefix}-${name}`,
        name: `${prefix} Head`,
        x: 18,
        y,
        width: 80,
        height: 6,
        text: `${name} running head`,
      });
    }
    await call(client, 'apply_master', { document, master: 'B-Chapter', pages: [2, 3] });
    await call(client, 'apply_master', { document, master: 'C-Gallery', pages: [4] });
    await call(client, 'apply_master', { document, master: 'D-Back', pages: [5, 6] });

    const masters = await call(client, 'list', { what: 'masters', document });
    const text = masters.content[0]?.text ?? '';
    expect(text).toContain('B-Chapter');
    expect(text).toContain('pages 2, 3');
    expect(text).toContain('C-Gallery');
    expect(text).toContain('pages 4');
    expect(text).toContain('D-Back');
    expect(text).toContain('pages 5, 6');

    // New pages can be given any of them, not just the first master.
    await call(client, 'edit_pages', { op: 'add', document, count: 1, master: 'C-Gallery' });
    const pages = await call(client, 'list', { what: 'pages', document });
    expect((pages.content[0]?.text ?? '').split('\n').at(-1)).toContain('C-Gallery');

    const validated = await call(client, 'validate_document', { document });
    expect(validated.content[0]?.text ?? '').toContain('No problems found');
  });
});

describe('editing items on a master page', () => {
  test('move and align use the master page the item is on, not the spread', async () => {
    const client = await connectedClient();
    const document = docPath('mastermove');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 2, facingPages: true });
    await call(client, 'add_text_frame', {
      document,
      master: 'A-Master',
      masterPage: 'right',
      name: 'Head',
      x: 18,
      y: 12,
      width: 80,
      height: 6,
      text: 'Head',
    });

    const moved = await call(client, 'edit_item', { op: 'move', document, item: 'Head', x: 60, y: 20 });
    // Page-relative, as given — before this it landed at y = 20 + half the page height.
    expect(moved.content[0]?.text ?? '').toContain('60mm, 20mm');
    expect(moved.content[0]?.text ?? '').not.toContain('pasteboard');

    const aligned = await call(client, 'edit_item', {
      op: 'align',
      document,
      items: ['Head'],
      horizontal: 'right',
      to: 'page',
    });
    expect(aligned.isError).toBeFalsy();
    const items = await call(client, 'list', { what: 'items', document, includeMasters: true });
    // Flush with the right edge of its own master page: 210mm - 80mm.
    expect(items.content[0]?.text ?? '').toContain('130mm, 20mm');
  });
});

describe('copying from a reference', () => {
  test('threaded frames copied together stay threaded, and dangling threads are cut', async () => {
    const client = await connectedClient();
    const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-ref-'));
    const reference = join(dir, 'threaded.idml');
    await call(client, 'new_document', { path: reference, pageSize: 'A4', pages: 1 });
    await call(client, 'add_text_frame', {
      document: reference,
      page: 1,
      name: 'Col A',
      x: 18,
      y: 40,
      width: 80,
      height: 100,
      text: 'Some text that runs on into the second column of this page.',
    });
    await call(client, 'add_text_frame', {
      document: reference,
      page: 1,
      name: 'Col B',
      x: 110,
      y: 40,
      width: 80,
      height: 100,
    });
    await call(client, 'thread_text_frames', { document: reference, from: 'Col A', to: 'Col B' });
    await call(client, 'add_reference_folder', { folder: dir });

    const document = docPath('copied');
    await call(client, 'new_document', { path: document, pageSize: 'A4', pages: 1 });
    await call(client, 'copy_page_from_reference', { document, reference: 'threaded', page: 1 });

    // The copies used to keep the source's frame ids, which do not exist here.
    const validated = await call(client, 'validate_document', { document });
    expect(validated.content[0]?.text ?? '').toContain('No problems found');
  });
});

describe('tables that outgrow their frame', () => {
  test('styling that makes a table taller says so, and preflight sees it', async () => {
    const client = await connectedClient();
    const document = docPath('tablefit');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'add_table', {
      document,
      page: 1,
      name: 'Diary',
      x: 18,
      y: 40,
      width: 174,
      headerRows: 1,
      data: [
        ['Date', 'Event'],
        ['3 October', 'Autumn walk'],
        ['17 October', "Members' evening"],
        ['7 November', 'Winter lecture'],
      ],
    });
    // add_table fits the frame to the table; a bigger inset makes every row taller.
    const styled = await call(client, 'style_table', {
      document,
      frame: 'Diary',
      inset: 8,
      verticalAlignment: 'center',
    });
    expect(styled.content[0]?.text ?? '').toContain('cut off');

    // A table is not overset text, so this used to pass preflight silently — and when it is
    // reported, it should say a table is cut off rather than that text does not fit.
    const report = await call(client, 'preflight_document', { document });
    const text = report.content[0]?.text ?? '';
    expect(text).toContain('The table in "Diary" is taller than its frame');
    expect(text).not.toContain('Text does not fit in "Diary"');
  });
});

describe('the order elements go into a document', () => {
  test('a gradient and a hyperlink land where the IDML schema expects them', async () => {
    const client = await connectedClient();
    const document = docPath('order');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    await call(client, 'create_gradient', {
      document,
      name: 'Fade',
      stops: [{ color: 'Black' }, { color: 'Paper' }],
    });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      name: 'Colophon',
      x: 18,
      y: 40,
      width: 120,
      height: 20,
      text: 'Visit example.com for more.',
    });
    await call(client, 'add_hyperlink', {
      document,
      item: 'Colophon',
      text: 'example.com',
      url: 'https://example.com',
    });

    // Both parts have a fixed element order; appending at the end put later elements out of place.
    const validated = await call(client, 'validate_document', { document });
    const text = validated.content[0]?.text ?? '';
    expect(text).not.toContain('is not allowed here');
  });
});
