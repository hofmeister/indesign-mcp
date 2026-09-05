import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IdmlDocument } from '../../src/idml/document.ts';
import { createTextFrame, listItems } from '../../src/idml/items.ts';
import { listPages } from '../../src/idml/pages.ts';
import { listStyles, listSwatches } from '../../src/idml/styles.ts';
import { createDocument } from '../../src/idml/template.ts';
import { validateDocument } from '../../src/idml/validate.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'idml');

describe('blank template', () => {
  test('creates an A4 document with the requested pages, margins and columns', () => {
    const doc = createDocument({
      pageSize: 'A4',
      pages: 3,
      margins: '15mm',
      columns: 2,
      gutter: '5mm',
      bleed: '3mm',
    });
    const pages = listPages(doc);
    expect(pages).toHaveLength(3);
    expect(pages[0]!.width).toBeCloseTo(595.2756, 2);
    expect(pages[0]!.height).toBeCloseTo(841.8898, 2);
    expect(pages[0]!.margins.top).toBeCloseTo(42.52, 1);
    expect(pages[0]!.columns).toEqual({ count: 2, gutter: 14.173228 });
    expect(pages[0]!.side).toBe('right'); // template is facing pages
    expect(listItems(doc)).toHaveLength(0);
    const again = IdmlDocument.fromBytes(doc.toBytes());
    expect(listPages(again)).toHaveLength(3);
    const errors = validateDocument(again).filter((i) => i.level === 'error');
    expect(errors).toEqual([]);
  });

  test('landscape, single pages, custom size', () => {
    const doc = createDocument({ width: '200mm', height: '100mm', facingPages: false, pages: 2 });
    const pages = listPages(doc);
    expect(pages.map((p) => p.side)).toEqual(['single', 'single']);
    expect(pages[0]!.width).toBeCloseTo(566.93, 1);
    expect(pages[1]!.origin.x).toBeCloseTo(-283.46, 1);
  });

  test('has the InDesign defaults a designer expects', () => {
    const doc = createDocument();
    expect(listStyles(doc, 'ParagraphStyle').map((s) => s.name)).toContain('[Basic Paragraph]');
    const swatches = listSwatches(doc).map((s) => s.name);
    expect(swatches).toEqual(expect.arrayContaining(['None', 'Paper', 'Black', 'Registration']));
    const el = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 40, y: 40, width: 300, height: 100 }, text: 'Hello' },
    );
    expect(el.getAttribute('ItemLayer')).toBe(
      doc.root.getElementsByTagName('Layer')[0]!.getAttribute('Self'),
    );
    expect(validateDocument(doc).filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('validator', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.idml'));
  test.each(files)('reports no errors for real export %s', (file) => {
    const doc = IdmlDocument.load(join(FIXTURES, file));
    const issues = validateDocument(doc);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  test('catches dangling references', () => {
    const doc = createDocument();
    const el = createTextFrame(doc, { page: 1 }, { rect: { x: 0, y: 0, width: 10, height: 10 }, text: 'x' });
    el.setAttribute('ParentStory', 'u999999');
    el.setAttribute('FillColor', 'Color/Nope');
    const errors = validateDocument(doc).filter((i) => i.level === 'error');
    expect(errors.some((e) => e.message.includes('ParentStory'))).toBe(true);
    expect(errors.some((e) => e.message.includes('Color/Nope'))).toBe(true);
  });
});
