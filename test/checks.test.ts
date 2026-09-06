// Guardrails: input that cannot work is refused, and items that land off the page come back
// with a warning instead of quietly disappearing.
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { applyMargins, createDocument } from '../src/idml/template.ts';
import { resolvePageSize } from '../src/idml/units.ts';
import { createServer } from '../src/server.ts';
import { pageBoxFor, placementWarnings, requireLine, requireSize } from '../src/tools/checks.ts';
import { ToolContext } from '../src/tools/context.ts';

const ctx = new ToolContext(loadConfig({ INDESIGN_MCP_DOCUMENTS: tmpdir() }));

describe('geometry guards', () => {
  test('a frame needs a positive width and height', () => {
    expect(() => requireSize(ctx, { x: 0, y: 0, width: 0, height: 50 }, 'text frame')).toThrow(
      /positive width and height/,
    );
    expect(() => requireSize(ctx, { x: 0, y: 0, width: -30, height: 50 }, 'rectangle')).toThrow(
      /positive width and height/,
    );
    expect(() => requireSize(ctx, { x: 0, y: 0, width: Number.NaN, height: 50 }, 'rectangle')).toThrow(
      /not a number/,
    );
    expect(() => requireSize(ctx, { x: 0, y: 0, width: 100, height: 50 }, 'rectangle')).not.toThrow();
  });

  test('nothing may be larger than InDesign allows', () => {
    expect(() => requireSize(ctx, { x: 0, y: 0, width: 20000, height: 50 }, 'rectangle')).toThrow(
      /bigger than InDesign allows/,
    );
    expect(() => resolvePageSize(undefined, undefined, '6000mm', '100mm')).toThrow(/larger than InDesign/);
    expect(() => resolvePageSize(undefined, undefined, '0mm', '100mm')).toThrow(/positive size/);
  });

  test('a line needs two different points', () => {
    expect(() => requireLine(ctx, { x: 10, y: 10 }, { x: 10, y: 10 })).toThrow(/two different points/);
    expect(() => requireLine(ctx, { x: 10, y: 10 }, { x: 10, y: 40 })).not.toThrow();
  });

  test('warns about items off the page and over the trim', () => {
    const doc = createDocument({ pageSize: 'A5' }); // 419 × 595 pt
    const box = pageBoxFor(doc, { page: 1 })!;
    expect(box.width).toBeCloseTo(419.528, 1);

    const onPage = placementWarnings(ctx, { x: 20, y: 20, width: 100, height: 50 }, box, 'rectangle');
    expect(onPage).toEqual([]);

    const pasteboard = placementWarnings(ctx, { x: 2000, y: 20, width: 100, height: 50 }, box, 'rectangle');
    expect(pasteboard).toHaveLength(1);
    expect(pasteboard[0]).toContain('pasteboard');
    expect(pasteboard[0]).toContain('will not print');

    const bleeding = placementWarnings(ctx, { x: 380, y: -10, width: 100, height: 50 }, box, 'rectangle');
    expect(bleeding).toHaveLength(1);
    expect(bleeding[0]).toContain('past the top edge');
    expect(bleeding[0]).toContain('past the right edge');
  });

  test('margins have to leave room for text', () => {
    const doc = createDocument({ pageSize: 'A5' });
    expect(() => applyMargins(doc, { margins: '200mm' }, 'mm')).toThrow(/leave no room/);
    expect(() => applyMargins(doc, { columns: 20, gutter: '20mm' }, 'mm')).toThrow(/do not fit/);
    expect(() => applyMargins(doc, { margins: '15mm', columns: 2 }, 'mm')).not.toThrow();
  });
});

describe('the tools refuse impossible input', () => {
  let client: Client;
  let document: string;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      text: (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n'),
      data: r.structuredContent as Record<string, unknown> | undefined,
      isError: Boolean(r.isError),
    };
  };
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-checks-'));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer(
      loadConfig({ INDESIGN_MCP_DOCUMENTS: dir, INDESIGN_MCP_DISABLE_INDESIGN: '1' }),
    ).connect(st);
    client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    document = (await call('new_document', { path: 'checks', pageSize: 'A5' })).data!.path as string;
  });

  test('a zero-width frame is refused with an explanation', async () => {
    const r = await call('add_text_frame', {
      document,
      x: 20,
      y: 20,
      width: 0,
      height: 40,
      text: 'Nothing',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('positive width and height');
    expect(r.text).toContain('use x and y');
  });

  test('a negative width is refused', async () => {
    const r = await call('add_rectangle', { document, x: 20, y: 20, width: -50, height: 40 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('positive width and height');
  });

  test('a line with two identical ends is refused', async () => {
    const r = await call('add_line', { document, x1: 10, y1: 10, x2: 10, y2: 10 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('two different points');
  });

  test('an item placed off the page is created, with a warning', async () => {
    const r = await call('add_rectangle', {
      document,
      x: 500,
      y: 20,
      width: 50,
      height: 40,
      name: 'Stray',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Note:');
    expect(r.text).toContain('pasteboard');
    expect((r.data!.notes as string[]).length).toBe(1);
  });

  test('an item over the trim edge is created, with a bleed note', async () => {
    const r = await call('add_rectangle', {
      document,
      x: 120,
      y: 20,
      width: 50,
      height: 40,
      name: 'Bleeder',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('past the right edge');
    expect(r.text).toContain('bleed');
  });

  test('moving or resizing an item off the page warns too', async () => {
    await call('add_rectangle', { document, x: 20, y: 20, width: 50, height: 40, name: 'Mover' });
    const moved = await call('move_item', { document, item: 'Mover', x: 400, y: 20 });
    expect(moved.isError).toBe(false);
    expect(moved.text).toContain('pasteboard');
    const resized = await call('resize_item', { document, item: 'Mover', width: -10 });
    expect(resized.isError).toBe(true);
    expect(resized.text).toContain('has to be positive');
  });

  test('out-of-range typography values are refused by the schema', async () => {
    const big = await call('create_paragraph_style', { document, name: 'Huge', size: 5000 });
    expect(big.isError).toBe(true);
    const tracking = await call('create_paragraph_style', { document, name: 'Wide', tracking: 99999 });
    expect(tracking.isError).toBe(true);
    const fine = await call('create_paragraph_style', { document, name: 'Fine', size: 11, tracking: 20 });
    expect(fine.isError).toBe(false);
  });

  test('a swatch with impossible values is refused', async () => {
    const r = await call('create_swatch', { document, name: 'Impossible', cmyk: [0, 200, 0, 0] });
    expect(r.isError).toBe(true);
    const ok = await call('create_swatch', { document, name: 'Fine blue', cmyk: [100, 60, 0, 0] });
    expect(ok.isError).toBe(false);
  });

  test('margins that do not fit are refused', async () => {
    const r = await call('set_margins_and_columns', { document, margins: '200mm' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('leave no room');
    // and the document is still usable afterwards
    const pages = await call('list_pages', { document });
    expect(pages.isError).toBe(false);
  });
});

describe('copies are checked too', () => {
  let client: Client;
  let document: string;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      text: (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n'),
      data: r.structuredContent as Record<string, unknown> | undefined,
      isError: Boolean(r.isError),
    };
  };
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-copies-'));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer(
      loadConfig({ INDESIGN_MCP_DOCUMENTS: dir, INDESIGN_MCP_DISABLE_INDESIGN: '1' }),
    ).connect(st);
    client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    document = (await call('new_document', { path: 'copies', pageSize: 'A5' })).data!.path as string;
    await call('add_rectangle', { document, x: 20, y: 20, width: 40, height: 30, name: 'Tile' });
  });

  test('a duplicate pushed off the page is reported', async () => {
    const r = await call('duplicate_item', { document, item: 'Tile', dx: 400, dy: 0, name: 'Far copy' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('pasteboard');
  });

  test('a step and repeat grid that runs off the page is reported once', async () => {
    const r = await call('step_and_repeat', {
      document,
      item: 'Tile',
      rows: 2,
      columns: 8,
      offsetX: 45,
      offsetY: 35,
    });
    expect(r.isError).toBe(false);
    expect(r.data!.created).toBe(15);
    expect((r.data!.notes as string[]).length).toBe(1);
    expect(r.text).toContain('one of the copies');
  });
});
