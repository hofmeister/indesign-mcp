import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { IdmlDocument } from '../../src/idml/document.ts';
import {
  createLine,
  createOval,
  createRectangle,
  createTextFrame,
  deleteItem,
  duplicateItem,
  findItem,
  listItems,
  moveItemTo,
  resizeItem,
  rotateItem,
  setFill,
} from '../../src/idml/items.ts';
import { createLayer, listLayers } from '../../src/idml/layers.ts';
import { addPages, findPage, listPages, removePages } from '../../src/idml/pages.ts';
import {
  appendStoryText,
  applyParagraphStyle,
  formatMatches,
  readStory,
  readStoryPlainText,
  replaceInStory,
  setStoryText,
} from '../../src/idml/stories.ts';
import {
  createCharacterStyle,
  createParagraphStyle,
  createSwatch,
  listStyles,
  listSwatches,
  resolveSwatch,
  styleSelf,
} from '../../src/idml/styles.ts';
import { createDocument } from '../../src/idml/template.ts';
import { toPoints } from '../../src/idml/units.ts';
import { validateDocument } from '../../src/idml/validate.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'idml');
const load = (name = 'interview.idml') => IdmlDocument.load(join(FIXTURES, name));
const mm = (v: number) => toPoints(v, 'mm');

function reload(doc: IdmlDocument): IdmlDocument {
  return IdmlDocument.fromBytes(doc.toBytes());
}

describe('pages', () => {
  test('lists pages with geometry', () => {
    const pages = listPages(load('4-pages.idml'));
    expect(pages).toHaveLength(4);
    expect(pages[0]!.index).toBe(1);
    expect(pages[0]!.width).toBeCloseTo(566.93, 1);
    expect(pages.map((p) => p.side)).toEqual(['right', 'left', 'right', 'left']);
  });

  test('adds pages following the facing-pages layout and updates counts', () => {
    const doc = load('4-pages.idml');
    const added = addPages(doc, { count: 3 });
    expect(added.map((p) => p.index)).toEqual([5, 6, 7]);
    const pages = listPages(doc);
    expect(pages.map((p) => p.side)).toEqual(['right', 'left', 'right', 'left', 'right', 'left', 'right']);
    // page 5 shares a spread with page 4
    expect(pages[4]!.spreadId).toBe(pages[3]!.spreadId);
    expect(pages[5]!.spreadId).not.toBe(pages[4]!.spreadId);
    const again = reload(doc);
    expect(listPages(again)).toHaveLength(7);
    // Stays 1 however many pages the document has: it is the New Document default, and InDesign
    // pre-creates that many blank pages before reading the spreads.
    expect(
      again
        .resource('Preferences')
        .getElementsByTagName('DocumentPreference')[0]!
        .getAttribute('PagesPerDocument'),
    ).toBe('1');
    expect(again.root.getElementsByTagName('Section')[0]!.getAttribute('Length')).toBe('7');
    expect(again.spreads().at(-1)!.getAttribute('PageCount')).toBe('2');
  });

  // Regression: a document that says it has more than one "new document" page makes InDesign
  // create that many blank pages before it reads the spreads, so the real pages end up behind
  // N-1 blanks. Every document we write must pin PagesPerDocument to 1.
  test('never claims more than one page in PagesPerDocument', () => {
    const perDocument = (d: IdmlDocument) =>
      d
        .resource('Preferences')
        .getElementsByTagName('DocumentPreference')[0]!
        .getAttribute('PagesPerDocument');
    for (const pages of [1, 3, 5]) {
      const doc = createDocument({ pageSize: 'A5', pages, margins: '12.7mm' });
      expect(listPages(doc)).toHaveLength(pages);
      expect(perDocument(reload(doc))).toBe('1');
      expect(validateDocument(doc).filter((i) => /PagesPerDocument/.test(i.message))).toEqual([]);
    }
    // and adding pages later must not put it back
    const doc = createDocument({ pageSize: 'A5', pages: 1, margins: '12.7mm' });
    addPages(doc, { count: 4 });
    expect(listPages(doc)).toHaveLength(5);
    expect(perDocument(reload(doc))).toBe('1');
  });

  test('validate flags a document that would open with leading blank pages', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 3, margins: '12.7mm' });
    doc
      .resource('Preferences')
      .getElementsByTagName('DocumentPreference')[0]!
      .setAttribute('PagesPerDocument', '3');
    const issue = validateDocument(doc).find((i) => /PagesPerDocument/.test(i.message));
    expect(issue?.level).toBe('error');
    expect(issue?.message).toMatch(/2 blank page/);
  });

  test('removes a page and its items', () => {
    const doc = load('4-pages.idml');
    const before = listItems(doc).length;
    removePages(doc, [1]);
    const pages = listPages(reload(doc));
    expect(pages).toHaveLength(3);
    expect(listItems(doc).length).toBeLessThan(before);
    expect(() => removePages(doc, [1, 2, 3])).toThrow(/at least one page/);
  });
});

describe('items and stories', () => {
  test('creates a text frame with text on a page', () => {
    const doc = load();
    const page = findPage(doc, 1);
    const el = createTextFrame(
      doc,
      { page: 1 },
      {
        rect: { x: mm(20), y: mm(30), width: mm(100), height: mm(50) },
        text: 'Hello **InDesign**\nSecond paragraph',
        name: 'Headline',
      },
    );
    const id = el.getAttribute('Self')!;
    const again = reload(doc);
    const found = findItem(again, 'Headline');
    expect(found.info.id).toBe(id);
    expect(found.info.type).toBe('text');
    expect(found.info.page).toBe(1);
    expect(found.info.bounds!.x).toBeCloseTo(mm(20), 3);
    expect(found.info.bounds!.y).toBeCloseTo(mm(30), 3);
    expect(found.info.bounds!.width).toBeCloseTo(mm(100), 3);
    expect(found.info.text).toBe('Hello InDesign\nSecond paragraph');
    const story = again.story(found.info.storyId!)!;
    const paras = readStory(story);
    expect(paras).toHaveLength(2);
    expect(paras[0]!.runs[1]!.attrs?.FontStyle).toBe('Bold');
    expect(again.root.getAttribute('StoryList')).toContain(found.info.storyId!);
    expect(again.storyParts()).toContain(`Stories/Story_${found.info.storyId}.xml`);
    expect(el.getAttribute('ItemLayer')).toBeTruthy();
    void page;
  });

  test('edits story text in place', () => {
    const doc = load();
    const el = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 0, y: 0, width: 100, height: 100 }, text: 'one\ntwo\nthree' },
    );
    const story = doc.story(el.getAttribute('ParentStory')!)!;
    expect(replaceInStory(story, 'two', 'deux')).toBe(1);
    appendStoryText(doc, story, 'four');
    expect(readStoryPlainText(story)).toBe('one\ndeux\nthree\nfour');
    setStoryText(doc, story, 'fresh');
    expect(readStoryPlainText(story)).toBe('fresh');
    expect(formatMatches(story, 'fre', { attrs: { FontStyle: 'Bold' } })).toBe(1);
    const paras = readStory(story);
    expect(paras[0]!.runs.map((r) => r.text)).toEqual(['fre', 'sh']);
    expect(paras[0]!.runs[0]!.attrs?.FontStyle).toBe('Bold');
    const styleSelfId = styleSelf(doc, 'ParagraphStyle', 'Question');
    expect(applyParagraphStyle(story, styleSelfId)).toBe(1);
    expect(readStory(story)[0]!.style).toBe('ParagraphStyle/Question');
  });

  test('creates shapes, moves, resizes, rotates, duplicates and deletes', () => {
    const doc = load('4-pages.idml');
    const rect = createRectangle(
      doc,
      { page: 2 },
      { rect: { x: 10, y: 10, width: 100, height: 50 }, fill: '#ff0000', name: 'Box' },
    );
    createOval(
      doc,
      { page: 2 },
      {
        rect: { x: 10, y: 100, width: 50, height: 50 },
        fill: 'cmyk(0,100,0,0)',
        stroke: 'Black',
        strokeWeight: 2,
        name: 'Dot',
      },
    );
    createLine(
      doc,
      { page: 2 },
      { from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, strokeWeight: 0.5, name: 'Rule' },
    );
    expect(rect.getAttribute('FillColor')).toBe('Color/R=255 G=0 B=0');
    expect(listSwatches(doc).some((s) => s.name === 'R=255 G=0 B=0')).toBe(true);

    const page = findPage(doc, 2);
    const box = findItem(doc, 'Box', 2);
    expect(box.info.page).toBe(2);
    moveItemTo(box.element, { x: page.origin.x + 50, y: page.origin.y + 60 });
    const moved = findItem(doc, 'Box').info.bounds!;
    expect(moved.x).toBeCloseTo(50, 3);
    expect(moved.y).toBeCloseTo(60, 3);
    expect(moved.width).toBeCloseTo(100, 3);
    resizeItem(box.element, 200, undefined);
    expect(findItem(doc, 'Box').info.bounds!.width).toBeCloseTo(200);
    rotateItem(box.element, 45);
    expect(findItem(doc, 'Box').info.rotation).toBeCloseTo(45, 1);

    const dotId = findItem(doc, 'Dot').info.id;
    const dup = duplicateItem(doc, findItem(doc, 'Dot'));
    expect(dup.getAttribute('Self')).not.toBe(dotId);
    expect(() => findItem(doc, 'Dot')).toThrow(/matches 2 items/);

    const items = listItems(doc, { page: 2 });
    expect(items.filter((i) => i.name === 'Dot')).toHaveLength(2);
    deleteItem(doc, findItem(doc, 'Rule').element);
    expect(() => findItem(doc, 'Rule')).toThrow(/No item/);
    const again = reload(doc);
    expect(
      listItems(again, { page: 2 })
        .map((i) => i.type)
        .sort(),
    ).toEqual(['ellipse', 'ellipse', 'rectangle']);
  });

  test('deleting a text frame removes its story part', () => {
    const doc = load();
    const el = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 0, y: 0, width: 50, height: 50 }, text: 'bye' },
    );
    const storyId = el.getAttribute('ParentStory')!;
    expect(doc.storyParts()).toContain(`Stories/Story_${storyId}.xml`);
    deleteItem(doc, el);
    expect(doc.storyParts()).not.toContain(`Stories/Story_${storyId}.xml`);
    expect(doc.root.getAttribute('StoryList')).not.toContain(storyId);
    expect(reload(doc).partNames()).not.toContain(`Stories/Story_${storyId}.xml`);
  });
});

describe('styles, swatches, layers', () => {
  test('lists styles from a real document', () => {
    const doc = load();
    const names = listStyles(doc, 'ParagraphStyle').map((s) => s.name);
    expect(names).toContain('[Basic Paragraph]');
    expect(names).toContain('Question');
    const q = listStyles(doc, 'ParagraphStyle').find((s) => s.name === 'Question')!;
    expect(q.font).toBe('Playfair Display');
    expect(q.fontStyle).toBe('Bold');
  });

  test('creates paragraph and character styles', () => {
    const doc = load('4-pages.idml');
    const info = createParagraphStyle(doc, {
      name: 'Heading 1',
      font: 'Minion Pro',
      fontStyle: 'Bold',
      size: 24,
      leading: 28,
      alignment: 'center',
      spaceAfter: 6,
      color: 'cmyk(100,50,0,0)',
    });
    expect(info.self).toBe('ParagraphStyle/Heading 1');
    createCharacterStyle(doc, { name: 'Emphasis', fontStyle: 'Italic', color: 'Black' });
    createParagraphStyle(doc, { name: 'Body', basedOn: 'Heading 1', size: 10, group: 'Text' });
    const again = reload(doc);
    const h1 = listStyles(again, 'ParagraphStyle').find((s) => s.name === 'Heading 1')!;
    expect(h1.pointSize).toBe(24);
    expect(h1.leading).toBe('28');
    expect(h1.alignment).toBe('CenterAlign');
    expect(h1.fillColor).toBe('Color/C=100 M=50 Y=0 K=0');
    const body = listStyles(again, 'ParagraphStyle').find((s) => s.name === 'Body')!;
    expect(body.group).toBe('Text');
    expect(body.basedOn).toBe('Heading 1');
    expect(styleSelf(again, 'CharacterStyle', 'emphasis')).toBe('CharacterStyle/Emphasis');
    expect(() => createParagraphStyle(doc, { name: 'Heading 1' })).toThrow(/already exists/);
  });

  test('creates swatches and resolves colors', () => {
    const doc = load();
    const sw = createSwatch(doc, { name: 'Brand Blue', cmyk: [90, 60, 0, 0] });
    expect(sw.self).toBe('Color/Brand Blue');
    expect(sw.hex).toBeTruthy();
    expect(resolveSwatch(doc, 'brand blue')).toBe('Color/Brand Blue');
    expect(resolveSwatch(doc, 'none')).toBe('Swatch/None');
    expect(resolveSwatch(doc, 'Paper')).toBe('Color/Paper');
    expect(resolveSwatch(doc, '#00ff00')).toBe('Color/R=0 G=255 B=0');
    expect(() => resolveSwatch(doc, 'Nonexistent Swatch')).toThrow(/Unknown swatch/);
    // root color group got a reference
    const refs = Array.from(doc.root.getElementsByTagName('ColorGroupSwatch')).map((e) =>
      e.getAttribute('SwatchItemRef'),
    );
    expect(refs).toContain('Color/Brand Blue');
    const again = reload(doc);
    expect(listSwatches(again).find((s) => s.name === 'Brand Blue')?.values).toEqual([90, 60, 0, 0]);
  });

  test('creates layers', () => {
    const doc = load('4-pages.idml');
    const before = listLayers(doc).length;
    const layer = createLayer(doc, 'Images', { color: 'Green' });
    expect(listLayers(reload(doc))).toHaveLength(before + 1);
    expect(listLayers(doc)[0]!.name).toBe('Images');
    const el = createRectangle(
      doc,
      { page: 1 },
      { rect: { x: 0, y: 0, width: 10, height: 10 }, layer: 'Images' },
    );
    expect(el.getAttribute('ItemLayer')).toBe(layer.id);
    void setFill;
  });
});
