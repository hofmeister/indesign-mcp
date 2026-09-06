// Regressions from the first round of real-document testing.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
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
    const listed = await call(client, 'list_styles', { document, kind: 'paragraph' });
    expect(listed.content[0]?.text).toContain('41');
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

    const items = await call(client, 'list_items', { document, page: 1 });
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
    await call(client, 'add_rectangle', {
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
