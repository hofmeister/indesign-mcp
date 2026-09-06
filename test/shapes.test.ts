import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { IdmlDocument } from '../src/idml/document.ts';
import { anchorBounds, readPaths } from '../src/idml/geometry.ts';
import { createRectangle, createTextFrame, findItem, listItems } from '../src/idml/items.ts';
import { createLayer, deleteLayer, listLayers, reorderLayer } from '../src/idml/layers.ts';
import { overrideMasterItem } from '../src/idml/masters.ts';
import { duplicatePage, movePage, spreadLayout } from '../src/idml/pageops.ts';
import { addPages, listPages } from '../src/idml/pages.ts';
import { validateAgainstSchema } from '../src/idml/schema.ts';
import {
  createFreePath,
  createPolygon,
  groupItems,
  polygonPath,
  stepAndRepeat,
  ungroupItems,
} from '../src/idml/shapes.ts';
import {
  applyObjectStyle,
  createGradient,
  createObjectStyle,
  listStyles,
  listSwatches,
} from '../src/idml/styles.ts';
import { createDocument } from '../src/idml/template.ts';
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

describe('polygons and paths', () => {
  test('polygon geometry', () => {
    const tri = polygonPath({ x: 0, y: 0, width: 100, height: 100 }, 3);
    expect(tri.points).toHaveLength(3);
    expect(tri.open).toBe(false);
    expect(tri.points[0]!.anchor.x).toBeCloseTo(50, 6); // starts at the top
    expect(tri.points[0]!.anchor.y).toBeCloseTo(0, 6);
    const star = polygonPath({ x: 0, y: 0, width: 100, height: 100 }, 5, 50);
    expect(star.points).toHaveLength(10);
    // the shape fills the box it was given, like every other shape tool here
    const b = anchorBounds([star]);
    expect(b.width).toBeCloseTo(100, 6);
    expect(b.height).toBeCloseTo(100, 6);
    expect(anchorBounds([polygonPath({ x: 10, y: 20, width: 80, height: 40 }, 6)])).toMatchObject({
      x: 10,
      y: 20,
    });
  });

  test('creates polygons, stars and free paths that validate', () => {
    const doc = createDocument({ pageSize: 'A4' });
    createPolygon(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 20, width: 80, height: 80 }, sides: 6, name: 'Hex', fill: 'Black' },
    );
    createPolygon(
      doc,
      { page: 1 },
      {
        rect: { x: 120, y: 20, width: 80, height: 80 },
        sides: 5,
        starInset: 50,
        name: 'Star',
        fill: 'cmyk(0,0,100,0)',
      },
    );
    createFreePath(
      doc,
      { page: 1 },
      {
        points: [
          { x: 20, y: 200 },
          { x: 100, y: 260 },
          { x: 200, y: 180 },
        ],
        smooth: true,
        name: 'Curve',
        stroke: 'Black',
        strokeWeight: 2,
      },
    );
    const again = IdmlDocument.fromBytes(doc.toBytes());
    const hex = findItem(again, 'Hex');
    expect(hex.info.type).toBe('polygon');
    expect(readPaths(hex.element)[0]!.points).toHaveLength(6);
    expect(hex.info.bounds!.x).toBeCloseTo(20, 1);
    expect(hex.info.bounds!.width).toBeCloseTo(80, 1);
    const curve = findItem(again, 'Curve');
    const cp = readPaths(curve.element)[0]!;
    expect(cp.open).toBe(true);
    expect(cp.points[1]!.left.x).not.toBe(cp.points[1]!.anchor.x); // smoothed
    expect(errorsOf(doc)).toEqual([]);
  });
});

describe('groups', () => {
  test('groups and ungroups keeping positions', () => {
    const doc = createDocument({ pageSize: 'A4' });
    createRectangle(doc, { page: 1 }, { rect: { x: 10, y: 10, width: 50, height: 50 }, name: 'A' });
    createRectangle(doc, { page: 1 }, { rect: { x: 100, y: 10, width: 50, height: 50 }, name: 'B' });
    const before = [findItem(doc, 'A').info.bounds!, findItem(doc, 'B').info.bounds!];
    const group = groupItems(doc, [findItem(doc, 'A'), findItem(doc, 'B')], 'Pair');
    const reloaded = IdmlDocument.fromBytes(doc.toBytes());
    const g = findItem(reloaded, 'Pair');
    expect(g.info.type).toBe('group');
    expect(g.info.children).toHaveLength(2);
    expect(g.info.bounds!.width).toBeCloseTo(140, 1);
    expect(listItems(reloaded, { page: 1 })).toHaveLength(1); // the group only
    expect(errorsOf(doc)).toEqual([]);

    const items = ungroupItems(doc, group);
    expect(items).toHaveLength(2);
    const after = [findItem(doc, 'A').info.bounds!, findItem(doc, 'B').info.bounds!];
    expect(after[0]!.x).toBeCloseTo(before[0]!.x, 3);
    expect(after[1]!.x).toBeCloseTo(before[1]!.x, 3);
    expect(listItems(doc, { page: 1 })).toHaveLength(2);
    expect(errorsOf(doc)).toEqual([]);
  });

  test('step and repeat', () => {
    const doc = createDocument({ pageSize: 'A4' });
    createRectangle(doc, { page: 1 }, { rect: { x: 20, y: 20, width: 40, height: 20 }, name: 'Label' });
    const created = stepAndRepeat(doc, findItem(doc, 'Label'), {
      rows: 3,
      columns: 2,
      offsetX: 50,
      offsetY: 30,
    });
    expect(created).toHaveLength(5);
    const items = listItems(doc, { page: 1 });
    expect(items).toHaveLength(6);
    const xs = items.map((i) => Math.round(i.bounds!.x)).sort((a, b) => a - b);
    expect(xs[0]).toBe(20);
    expect(xs.at(-1)).toBe(70);
    expect(errorsOf(doc)).toEqual([]);
  });
});

describe('object styles and gradients', () => {
  test('creates and applies an object style', () => {
    const doc = createDocument({ pageSize: 'A4' });
    createObjectStyle(doc, {
      name: 'Card',
      fill: 'cmyk(0,0,0,10)',
      stroke: 'Black',
      strokeWeight: 1,
      cornerRadius: 8,
      inset: 6,
      columns: 1,
    });
    expect(listStyles(doc, 'ObjectStyle').map((s) => s.name)).toContain('Card');
    const rect = createRectangle(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 20, width: 200, height: 100 }, name: 'Box' },
    );
    applyObjectStyle(doc, rect, 'Card');
    expect(rect.getAttribute('AppliedObjectStyle')).toBe('ObjectStyle/Card');
    expect(rect.getAttribute('StrokeWeight')).toBe('1');
    expect(rect.getAttribute('TopLeftCornerRadius')).toBe('8');
    const frame = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 200, width: 200, height: 100 }, text: 'Hi', name: 'T' },
    );
    applyObjectStyle(doc, frame, 'Card');
    expect(frame.getElementsByTagName('TextFramePreference')[0]!.getAttribute('TextColumnCount')).toBe('1');
    expect(errorsOf(doc)).toEqual([]);
  });

  test('creates a gradient swatch and uses it as a fill', () => {
    const doc = createDocument({ pageSize: 'A4' });
    const g = createGradient(doc, {
      name: 'Sunset',
      type: 'linear',
      stops: [{ color: 'cmyk(0,60,100,0)' }, { color: 'cmyk(0,100,50,0)' }],
    });
    expect(g.self).toBe('Gradient/Sunset');
    expect(listSwatches(doc).some((s) => s.name === 'Sunset' && s.kind === 'gradient')).toBe(true);
    const rect = createRectangle(
      doc,
      { page: 1 },
      { rect: { x: 0, y: 0, width: 100, height: 100 }, fill: 'Sunset' },
    );
    expect(rect.getAttribute('FillColor')).toBe('Gradient/Sunset');
    expect(errorsOf(doc)).toEqual([]);
  });
});

describe('page and layer operations', () => {
  test('spread layout rules', () => {
    expect(spreadLayout(5, false)).toEqual([1, 1, 1, 1, 1]);
    expect(spreadLayout(5, true)).toEqual([1, 2, 2]);
    expect(spreadLayout(0, true)).toEqual([]);
  });

  test('moves a page with its content', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 3 });
    for (const n of [1, 2, 3])
      createTextFrame(
        doc,
        { page: n },
        { rect: { x: 20, y: 20, width: 200, height: 40 }, text: `Page ${n}`, name: `T${n}` },
      );
    movePage(doc, 3, 1);
    const again = IdmlDocument.fromBytes(doc.toBytes());
    const pages = listPages(again);
    expect(pages).toHaveLength(3);
    const texts = pages.map((p) =>
      listItems(again, { page: p.index })
        .map((i) => i.text)
        .join(''),
    );
    expect(texts).toEqual(['Page 3', 'Page 1', 'Page 2']);
    const first = findItem(again, 'T3');
    expect(first.info.page).toBe(1);
    expect(first.info.bounds!.x).toBeCloseTo(20, 1);
    expect(first.info.bounds!.y).toBeCloseTo(20, 1);
    expect(errorsOf(doc)).toEqual([]);
  });

  test('moves pages in a facing-pages document and keeps the spread layout', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 4, facingPages: true });
    createTextFrame(
      doc,
      { page: 4 },
      { rect: { x: 10, y: 10, width: 100, height: 30 }, text: 'last', name: 'L' },
    );
    movePage(doc, 4, 2);
    const again = IdmlDocument.fromBytes(doc.toBytes());
    const pages = listPages(again);
    expect(pages.map((p) => p.side)).toEqual(['right', 'left', 'right', 'left']);
    const moved = findItem(again, 'L');
    expect(moved.info.page).toBe(2);
    expect(moved.info.bounds!.x).toBeCloseTo(10, 1);
    expect(errorsOf(doc)).toEqual([]);
  });

  test('duplicates a page with its own story copies', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 1 });
    createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 20, width: 200, height: 40 }, text: 'Original', name: 'Src' },
    );
    const copy = duplicatePage(doc, 1);
    expect(copy.index).toBe(2);
    const again = IdmlDocument.fromBytes(doc.toBytes());
    const onTwo = listItems(again, { page: 2 });
    expect(onTwo).toHaveLength(1);
    expect(onTwo[0]!.text).toBe('Original');
    expect(onTwo[0]!.storyId).not.toBe(listItems(again, { page: 1 })[0]!.storyId);
    expect(errorsOf(doc)).toEqual([]);
  });

  test('layers: create, reorder, delete', () => {
    const doc = createDocument({ pageSize: 'A4' });
    createLayer(doc, 'Text');
    createLayer(doc, 'Images');
    expect(listLayers(doc).map((l) => l.name)).toEqual(['Images', 'Text', 'Layer 1']);
    reorderLayer(doc, 'Layer 1', 1);
    expect(listLayers(doc).map((l) => l.name)).toEqual(['Layer 1', 'Images', 'Text']);
    createRectangle(
      doc,
      { page: 1 },
      { rect: { x: 0, y: 0, width: 10, height: 10 }, layer: 'Images', name: 'R' },
    );
    const r = deleteLayer(doc, 'Images', { moveItemsTo: 'Text' });
    expect(r.moved).toBe(1);
    expect(listLayers(doc).map((l) => l.name)).toEqual(['Layer 1', 'Text']);
    expect(findItem(doc, 'R').element.getAttribute('ItemLayer')).toBe(
      listLayers(doc).find((l) => l.name === 'Text')!.id,
    );
    expect(errorsOf(doc)).toEqual([]);
  });

  test('overrides a master page item', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 2 });
    const masters = doc.masterSpreads();
    const masterName = masters[0]!.getAttribute('Name')!;
    createTextFrame(
      doc,
      { master: masterName },
      { rect: { x: 20, y: 250, width: 100, height: 20 }, text: 'Footer', name: 'Footer' },
    );
    for (const p of listPages(doc)) {
      const el = doc.findBySelf(p.id)!.element;
      el.setAttribute('AppliedMaster', masters[0]!.getAttribute('Self')!);
    }
    const el = overrideMasterItem(doc, 2, 'Footer');
    expect(el.getAttribute('Self')).toBeTruthy();
    const again = IdmlDocument.fromBytes(doc.toBytes());
    const onPage2 = listItems(again, { page: 2 });
    expect(onPage2.map((i) => i.text)).toContain('Footer');
    const pageEl = again.findBySelf(listPages(again)[1]!.id)!.element;
    expect(pageEl.getAttribute('OverrideList')).toBeTruthy();
    expect(() => overrideMasterItem(doc, 2, 'Footer')).toThrow(/already overridden/);
    expect(errorsOf(doc)).toEqual([]);
  });
});

describe('new tools over MCP', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-shapes-'));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer(
      loadConfig({ INDESIGN_MCP_DOCUMENTS: dir, INDESIGN_MCP_DISABLE_INDESIGN: '1' }),
    ).connect(st);
    client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
  });

  test('poster with shapes, gradient, object style and page moves', async () => {
    const created = await call('new_document', { path: 'poster', pageSize: 'A4', pages: 3 });
    const doc = created.data!.path as string;
    expect(
      (
        await call('create_gradient', {
          document: doc,
          name: 'Fade',
          stops: [{ color: '#ff8800' }, { color: '#003366' }],
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await call('add_shape', {
          shape: 'rectangle',
          document: doc,
          page: 1,
          x: 0,
          y: 0,
          width: 210,
          height: 100,
          fill: 'Fade',
          name: 'Band',
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await call('add_shape', {
          shape: 'polygon',
          document: doc,
          page: 1,
          x: 20,
          y: 120,
          width: 60,
          height: 60,
          sides: 5,
          starInset: 45,
          fill: '#ffcc00',
          name: 'Star',
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await call('add_shape', {
          shape: 'path',
          document: doc,
          page: 1,
          points: [
            { x: 20, y: 200 },
            { x: 105, y: 230 },
            { x: 190, y: 200 },
          ],
          smooth: true,
          stroke: 'Black',
          strokeWeight: 1.5,
          name: 'Swoosh',
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await call('create_object_style', {
          document: doc,
          name: 'Card',
          fill: '#ffffff',
          stroke: 'Black',
          strokeWeight: 0.5,
          cornerRadius: 6,
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await call('add_shape', {
          shape: 'rectangle',
          document: doc,
          page: 1,
          x: 20,
          y: 250,
          width: 80,
          height: 40,
          name: 'C1',
        })
      ).isError,
    ).toBe(false);
    expect((await call('apply_object_style', { document: doc, item: 'C1', style: 'Card' })).isError).toBe(
      false,
    );
    const sr = await call('step_and_repeat', {
      document: doc,
      item: 'C1',
      rows: 2,
      columns: 2,
      offsetX: 90,
      offsetY: 45,
    });
    expect(sr.data!.created).toBe(3);
    const grouped = await call('group_items', { document: doc, items: ['Star', 'Swoosh'], name: 'Art' });
    expect(grouped.isError).toBe(false);
    expect((await call('edit_pages', { op: 'move', document: doc, page: 3, to: 1 })).isError).toBe(false);
    expect((await call('edit_pages', { op: 'duplicate', document: doc, page: 2 })).data!.page).toBe(3);
    const v = await call('validate_document', { document: doc });
    expect(v.data!.errors).toBe(0);
    // the page was duplicated, so two items are called "Art" now: the page number disambiguates
    const ambiguous = await call('ungroup_items', { document: doc, group: 'Art' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain('matches 2 items');
    const ug = await call('ungroup_items', { document: doc, group: 'Art', page: 2 });
    expect(ug.isError).toBe(false);
    const prev = await call('preview', {
      what: 'page',
      document: doc,
      page: 2,
      width: 400,
      renderer: 'builtin',
    });
    expect(prev.isError).toBe(false);
  });
});

describe('existing documents survive the new operations', () => {
  test('moving pages in a real export keeps it valid', () => {
    const doc = IdmlDocument.load(join(import.meta.dir, 'fixtures', 'idml', '4-pages.idml'));
    addPages(doc, { count: 1 });
    movePage(doc, 1, 3);
    const again = IdmlDocument.fromBytes(doc.toBytes());
    expect(listPages(again)).toHaveLength(5);
    expect(validateDocument(again).filter((i) => i.level === 'error')).toEqual([]);
  });
});
