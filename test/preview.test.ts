import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { IdmlDocument } from '../src/idml/document.ts';
import { placeImage } from '../src/idml/images.ts';
import { createRectangle, createTextFrame, setCornerRadius } from '../src/idml/items.ts';
import { createParagraphStyle } from '../src/idml/styles.ts';
import { createTable, styleCells } from '../src/idml/tables.ts';
import { createDocument } from '../src/idml/template.ts';
import { decodeRaster } from '../src/images/thumbnail.ts';
import { cmykToRgb } from '../src/preview/color.ts';
import { fontCatalog } from '../src/preview/fonts.ts';
import { previewDocument, previewPage } from '../src/preview/index.ts';
import { svgToPng } from '../src/preview/png.ts';
import { measureTableHeight, renderPageSvg } from '../src/preview/svg.ts';
import { createServer } from '../src/server.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'idml');

function stats(png: Uint8Array): {
  width: number;
  height: number;
  dark: number;
  colored: number;
  total: number;
} {
  const r = decodeRaster(png, 'image/png')!;
  let dark = 0;
  let colored = 0;
  const total = r.width * r.height;
  for (let i = 0; i < r.data.length; i += 4) {
    const [R, G, B] = [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!];
    if (R < 90 && G < 90 && B < 90) dark++;
    if (Math.max(R, G, B) - Math.min(R, G, B) > 60) colored++;
  }
  return { width: r.width, height: r.height, dark, colored, total };
}

describe('preview building blocks', () => {
  test('CMYK conversion approximates InDesign screen colours', () => {
    const c = cmykToRgb(100, 0, 0, 0);
    expect(c[2]).toBeGreaterThan(200); // cyan is strongly blue
    expect(c[0]).toBeLessThan(40);
    const k = cmykToRgb(0, 0, 0, 100);
    expect(k[0]).toBeLessThan(50);
    expect(cmykToRgb(0, 0, 0, 0)).toEqual([255, 255, 255]);
    const violet = cmykToRgb(100, 100, 0, 0);
    expect(violet[2]).toBeGreaterThan(violet[1]);
  });

  test('bundled fonts load and substitutions are reported', () => {
    const cat = fontCatalog();
    cat.scan({ includeSystem: false });
    expect(cat.families()).toEqual(expect.arrayContaining(['Arimo', 'Tinos', 'Cousine']));
    const m = cat.match('Minion Pro', 'Bold');
    expect(m.substituted).toBe(true);
    expect(m.info.family).toBe('Tinos');
    expect(m.info.weight).toBe(700);
    // A family no computer has, so the sans-serif fallback is exercised whatever is installed.
    const s = cat.match('Nonexistent Grotesk', 'Italic');
    expect(s.substituted).toBe(true);
    expect(s.info.family).toBe('Arimo');
    expect(s.info.italic).toBe(true);
    expect(cat.match('Arimo', 'Regular').substituted).toBe(false);
  });

  test('font name fields are decoded to strings', () => {
    // fontkit returns name-table entries as raw bytes for some legacy macOS .ttc files. Any face
    // that keeps them as bytes throws inside register() and its whole font file is dropped.
    const cat = fontCatalog();
    const faces = cat.facesOf('Arimo');
    expect(faces.length).toBeGreaterThan(0);
    for (const f of cat.families()) expect(typeof f).toBe('string');
    for (const f of faces) {
      expect(typeof f.family).toBe('string');
      expect(typeof f.style).toBe('string');
      expect(typeof f.postscriptName).toBe('string');
    }
  });

  test('svg to png works', async () => {
    const { png, width, height } = await svgToPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="red"/></svg>',
      { width: 200 },
    );
    expect(width).toBe(200);
    expect(height).toBe(100);
    const s = stats(png);
    expect(s.colored).toBeGreaterThan(s.total * 0.9);
  });
});

describe('page rendering', () => {
  test('renders text, shapes and images of a generated document', async () => {
    const doc = createDocument({ pageSize: 'A5' });
    createParagraphStyle(doc, {
      name: 'Head',
      font: 'Arimo',
      fontStyle: 'Bold',
      size: 36,
      leading: 40,
      alignment: 'center',
      color: 'cmyk(0,100,100,0)',
    });
    createTextFrame(
      doc,
      { page: 1 },
      {
        rect: { x: 30, y: 30, width: 360, height: 120 },
        text: 'Big Red Headline\nSecond line of text that is long enough to wrap onto another line inside the frame.',
        paragraphStyle: 'ParagraphStyle/Head',
        name: 'H',
      },
    );
    createRectangle(
      doc,
      { page: 1 },
      {
        rect: { x: 30, y: 300, width: 200, height: 100 },
        fill: 'cmyk(100,0,0,0)',
        stroke: 'Black',
        strokeWeight: 3,
      },
    );
    placeImage(
      doc,
      { page: 1 },
      { rect: { x: 250, y: 300, width: 120, height: 100 } },
      { path: join(FIXTURES, 'media', 'default.jpg'), fit: 'fill' },
    );
    const svg = renderPageSvg(doc, 1, { showGuides: true });
    expect(svg.svg).toContain('<use href="#gl');
    expect(svg.svg).toContain('<image');
    expect(svg.substitutions).toEqual({});
    const { png } = await svgToPng(svg.svg, { width: 600 });
    const s = stats(png);
    expect(s.width).toBe(600);
    expect(s.dark).toBeGreaterThan(200); // text + stroke
    expect(s.colored).toBeGreaterThan(s.total * 0.05); // red headline + cyan box + photo
  });

  test('reports overset text and substitutions', async () => {
    const doc = createDocument({ pageSize: 'A6' });
    createTextFrame(
      doc,
      { page: 1 },
      {
        rect: { x: 10, y: 10, width: 60, height: 20 },
        text: 'This text is far too long for such a tiny frame and must overflow.',
        name: 'Tiny',
      },
    );
    const r = renderPageSvg(doc, 1);
    expect(r.warnings.some((w) => w.includes('overset'))).toBe(true);
    expect(Object.keys(r.substitutions).length).toBeGreaterThan(0); // Minion Pro is not installed here
  });

  test.each(['interview.idml', '4-pages.idml', '2articles-1photo.idml'])(
    'renders real export %s without throwing',
    async (file) => {
      const doc = IdmlDocument.load(join(FIXTURES, file));
      const r = await previewPage(doc, 1, { save: false, width: 500, renderer: 'builtin' });
      expect(r.renderer).toBe('builtin');
      const s = stats(r.png);
      expect(s.width).toBe(500);
      expect(s.dark + s.colored).toBeGreaterThan(50);
    },
  );

  test('a table of vertically centred cells keeps its row heights', () => {
    const doc = createDocument({ pageSize: 'A4', pages: 1 });
    const frame = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 40, y: 40, width: 400, height: 300 }, name: 'Table', text: '' },
    );
    const table = createTable(doc, frame, {
      rows: 4,
      columns: 3,
      headerRows: 1,
      data: [
        ['A', 'B', 'C'],
        ['1', '2', '3'],
        ['4', '5', '6'],
        ['7', '8', '9'],
      ],
      headerFill: 'Black',
    });
    styleCells(doc, table, undefined, { verticalJustification: 'center' });
    // Measured against the top of the cell: a centred cell used to report a row hundreds of
    // points tall, and its fill then flooded the whole table.
    const height = measureTableHeight(doc, table, 400);
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThan(300);
  });

  test('a bevelled text frame is drawn with cut corners', () => {
    const doc = createDocument({ pageSize: 'A4', pages: 1 });
    const frame = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 40, y: 40, width: 200, height: 100 }, name: 'Panel', text: '' },
    );
    setCornerRadius(frame, 6, 'bevel');
    const svg = renderPageSvg(doc, 1).svg;
    // Four cut corners: eight straight segments and no arcs.
    const path = (svg.match(/<path d="M[^"]*"/g) ?? []).find((p) => p.includes('L'));
    expect(path).toBeDefined();
    expect(path).not.toContain('A');
    expect((path!.match(/L/g) ?? []).length).toBe(8);
  });

  test('contact sheet of a multi-page document', async () => {
    const doc = IdmlDocument.load(join(FIXTURES, '4-pages.idml'));
    const r = await previewDocument(doc, { save: false, width: 800 });
    const s = stats(r.png);
    expect(s.width).toBe(800);
    expect(s.height).toBeGreaterThan(100);
  });
});

describe('inline images fit a tool result', () => {
  test('shrinking steps down until the budget is met, and reports the size it settled on', async () => {
    const { inlineImage } = await import('../src/images/thumbnail.ts');
    const { PNG } = await import('pngjs');
    // Noise: it defeats PNG and JPEG alike, so the first attempt cannot fit and the loop must run.
    const png = new PNG({ width: 2000, height: 2000 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = (i * 7919) % 256;
      png.data[i + 1] = (i * 104729) % 256;
      png.data[i + 2] = (i * 1299709) % 256;
      png.data[i + 3] = 255;
    }
    const bytes = new Uint8Array(PNG.sync.write(png));

    const capped = inlineImage(bytes, 'image/png', { maxEdge: 1400, maxBytes: 60_000 });
    expect(capped).toBeDefined();
    expect(Buffer.from(capped!.data, 'base64').length).toBeLessThanOrEqual(60_000);
    expect(capped!.reduced).toBe(true);
    expect(Math.max(capped!.width, capped!.height)).toBeLessThanOrEqual(1400);

    // It never shrinks past the floor, even when the budget is impossible.
    const floored = inlineImage(bytes, 'image/png', { maxEdge: 1400, maxBytes: 1 });
    expect(Math.max(floored!.width, floored!.height)).toBe(400);

    // An image already inside the budget is passed through at its own size.
    const small = new PNG({ width: 50, height: 40 });
    small.data.fill(255);
    const untouched = inlineImage(new Uint8Array(PNG.sync.write(small)), 'image/png');
    expect(untouched!.reduced).toBe(false);
    expect([untouched!.width, untouched!.height]).toEqual([50, 40]);

    expect(inlineImage(new Uint8Array([1, 2, 3]), 'image/png')).toBeUndefined();
  });
});

describe('preview tools', () => {
  let client: Client;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-prev-'));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer(
      loadConfig({ INDESIGN_MCP_DOCUMENTS: dir, INDESIGN_MCP_DISABLE_INDESIGN: '1' }),
    ).connect(st);
    client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
  });

  test('a huge render still comes back small, and the saved file keeps its resolution', async () => {
    const created = await client.callTool({
      name: 'new_document',
      arguments: { path: 'big', pageSize: 'A4', pages: 1 },
    });
    const doc = (created.structuredContent as { path: string }).path;
    // Dense text is the worst case: it compresses badly, so it is what overflowed the reply.
    await client.callTool({
      name: 'add_text_frame',
      arguments: {
        document: doc,
        x: 10,
        y: 10,
        width: 190,
        height: 275,
        text: 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '.repeat(60),
        name: 'Dense',
      },
    });
    const r = await client.callTool({
      name: 'preview',
      arguments: { what: 'page', document: doc, page: 1, width: 4000, renderer: 'builtin' },
    });
    expect(r.isError).toBeFalsy();
    const content = r.content as { type: string; data?: string; text?: string }[];
    const img = content.find((c) => c.type === 'image');
    // Comfortably inside a tool-result budget; the raw 4000 px PNG is several times this.
    expect((img?.data ?? '').length).toBeLessThan(800_000);

    // The document still reports the size it was actually rendered at...
    const structured = r.structuredContent as { width: number; savedTo: string };
    expect(structured.width).toBe(4000);
    // ...and the file on disk is that size, not the shrunken one.
    expect(existsSync(structured.savedTo)).toBe(true);
    expect(statSync(structured.savedTo).size).toBeGreaterThan(200_000);
    // The reply says so, rather than letting the model think it saw full detail.
    expect(content.find((c) => c.type === 'text')?.text).toContain('to keep the reply small');
  });

  test('preview_page returns an image and saves a file', async () => {
    const created = await client.callTool({
      name: 'new_document',
      arguments: { path: 'prev', pageSize: 'A5' },
    });
    const doc = (created.structuredContent as { path: string }).path;
    await client.callTool({
      name: 'add_text_frame',
      arguments: { document: doc, x: 10, y: 10, width: 100, height: 40, text: 'Preview me', name: 'T' },
    });
    const r = await client.callTool({
      name: 'preview',
      arguments: { what: 'page', document: doc, page: 1, width: 400, renderer: 'builtin' },
    });
    expect(r.isError).toBeFalsy();
    const content = r.content as { type: string; mimeType?: string; data?: string; text?: string }[];
    const img = content.find((c) => c.type === 'image');
    // The inline picture is re-encoded to keep the reply small — JPEG unless it needs alpha.
    expect(['image/jpeg', 'image/png']).toContain(img?.mimeType ?? '');
    expect((img?.data ?? '').length).toBeGreaterThan(1000);
    const saved = (r.structuredContent as { savedTo: string }).savedTo;
    expect(saved.endsWith('.png')).toBe(true);
    expect(existsSync(saved)).toBe(true);
    expect(content.find((c) => c.type === 'text')?.text).toContain('built-in renderer');
    const item = await client.callTool({
      name: 'preview',
      arguments: { what: 'item', document: doc, item: 'T', width: 300 },
    });
    expect(item.isError).toBeFalsy();
    const caps = await client.callTool({ name: 'preview_capabilities', arguments: {} });
    expect((caps.content as { text: string }[])[0]!.text).toContain('font families');
  });
});
