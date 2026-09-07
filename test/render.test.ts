// Preview fidelity: tables, lists, drop caps, tabs, text wrap and anchored objects.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRectangle, createTextFrame, findItem } from '../src/idml/items.ts';
import { createLayer, listLayers } from '../src/idml/layers.ts';
import { createMaster } from '../src/idml/masters.ts';
import { findPage, listPages, resolveMaster } from '../src/idml/pages.ts';
import { appendPageNumberMarker, setStoryText } from '../src/idml/stories.ts';
import {
  createCharacterStyle,
  createParagraphStyle,
  createSwatch,
  resolveStyle,
} from '../src/idml/styles.ts';
import { createTable } from '../src/idml/tables.ts';
import { createDocument } from '../src/idml/template.ts';
import { anchorItem, applyListSettings, setTabStops } from '../src/idml/typography.ts';
import { setGrepStyles, setNestedStyles } from '../src/idml/variables.ts';
import { attr, firstChild, propertiesOf, setAttrs } from '../src/idml/xml.ts';
import { decodeRaster } from '../src/images/thumbnail.ts';
import { cmykToRgb } from '../src/preview/color.ts';
import { fontCatalog } from '../src/preview/fonts.ts';
import { svgToPng } from '../src/preview/png.ts';
import { findOversetFrames, renderPageSvg } from '../src/preview/svg.ts';
import { Composer, formatListNumber, StyleResolver } from '../src/preview/textLayout.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'idml');

/** Colours found in the rendered page, as "r,g,b" → pixel count. */
async function pixelColours(svg: string, width = 500): Promise<Map<string, number>> {
  const { png } = await svgToPng(svg, { width });
  const raster = decodeRaster(png, 'image/png')!;
  const counts = new Map<string, number>();
  for (let i = 0; i < raster.data.length; i += 4) {
    const key = `${raster.data[i]},${raster.data[i + 1]},${raster.data[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function textFrame(
  doc: ReturnType<typeof createDocument>,
  name = 'Body',
  rect = { x: 20, y: 20, width: 280, height: 260 },
) {
  return createTextFrame(doc, { page: 1 }, { rect, text: '', name });
}

describe('tables in previews', () => {
  test('draws cells, their fills, strokes and text', async () => {
    const doc = createDocument({ pageSize: 'A5' });
    const frame = textFrame(doc, 'Prices');
    createTable(doc, frame, {
      rows: 3,
      columns: 2,
      headerRows: 1,
      data: [
        ['Item', 'Price'],
        ['Coffee', '25'],
        ['Tea', '20'],
      ],
      totalWidth: 240,
      headerFill: 'cmyk(0,0,0,20)',
    });
    const svg = renderPageSvg(doc, 1).svg;
    // six cells, each with four edges, plus the four table borders
    expect((svg.match(/<line /g) ?? []).length).toBeGreaterThanOrEqual(24);
    expect(svg).toContain('<use href="#gl');
    const colours = await pixelColours(svg);
    const headerFill = [...colours.entries()].filter(([k, n]) => {
      const [r, g, b] = k.split(',').map(Number) as [number, number, number];
      const light = Math.min(r, g, b) > 170 && Math.max(r, g, b) < 245;
      return n > 200 && light && Math.max(r, g, b) - Math.min(r, g, b) < 25;
    });
    expect(headerFill.length).toBeGreaterThan(0); // the grey header row
  });

  test('a table too tall for its frame is not drawn at all', () => {
    const doc = createDocument({ pageSize: 'A5' });
    const frame = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 20, width: 280, height: 40 }, text: '', name: 'Cut' },
    );
    createTable(doc, frame, {
      rows: 4,
      columns: 2,
      data: [
        ['A', 'B'],
        ['1', '2'],
        ['3', '4'],
        ['5', '6'],
      ],
      totalWidth: 280,
      rowHeights: [40, 40, 40, 40],
    });
    // InDesign puts the whole table overset rather than cutting it: drawing the rows that happen
    // to fit would make the preview look finished when the printed page is missing rows.
    const svg = renderPageSvg(doc, 1).svg;
    expect(svg).not.toContain('>A<');
    expect(findOversetFrames(doc)[0]?.table).toBe(true);
  });

  test('rows grow to fit the text in them', () => {
    const doc = createDocument({ pageSize: 'A5' });
    const short = textFrame(doc, 'Short');
    createTable(doc, short, { rows: 1, columns: 1, data: [['Tea']], totalWidth: 120 });
    const long = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 320, width: 280, height: 200 }, text: '', name: 'Long' },
    );
    createTable(doc, long, {
      rows: 1,
      columns: 1,
      data: [
        ['A cell with a good deal more text in it, enough to run over several lines in this narrow column.'],
      ],
      totalWidth: 120,
    });
    const svg = renderPageSvg(doc, 1).svg;
    const lines = [...svg.matchAll(/<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)"/g)].map(
      (m) => ({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) }),
    );
    const heightOf = (top: number) => {
      const verticals = lines.filter((l) => l.x1 === l.x2 && Math.abs(l.y1 - top) < 1);
      return Math.max(...verticals.map((l) => Math.abs(l.y2 - l.y1)));
    };
    const shortTop = Math.min(...lines.map((l) => l.y1));
    const longTop = Math.min(...lines.filter((l) => l.y1 > shortTop + 50).map((l) => l.y1));
    expect(heightOf(longTop)).toBeGreaterThan(heightOf(shortTop));
  });
});

describe('bullets and numbering', () => {
  test('draws a bullet in front of each list paragraph', () => {
    const doc = createDocument({ pageSize: 'A5' });
    createParagraphStyle(doc, { name: 'Plain', size: 11, leading: 15 });
    createParagraphStyle(doc, { name: 'Bulleted', size: 11, leading: 15 });
    applyListSettings(doc, resolveStyle(doc, 'ParagraphStyle', 'Bulleted'), {
      kind: 'bullet',
      bulletCharacter: '•',
      indent: 18,
      bulletIndent: 18,
    });
    const paragraphs = (style: string) =>
      [1, 2, 3].map((n) => ({ style, runs: [{ text: `Item number ${n}` }] }));
    const plain = textFrame(doc, 'Plain');
    setStoryText(doc, doc.story(plain.getAttribute('ParentStory')!)!, paragraphs('ParagraphStyle/Plain'));
    const listed = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 320, width: 280, height: 200 }, text: '', name: 'List' },
    );
    setStoryText(doc, doc.story(listed.getAttribute('ParentStory')!)!, paragraphs('ParagraphStyle/Bulleted'));
    const svg = renderPageSvg(doc, 1).svg;
    const uses = (svg.match(/<use href="#gl/g) ?? []).length;
    // the same text twice, plus three bullets
    expect(uses % 2).toBe(1);
  });

  test('numbers continue from paragraph to paragraph', () => {
    expect(formatListNumber(4, 'Arabic')).toBe('4');
    expect(formatListNumber(4, 'UpperRoman')).toBe('IV');
    expect(formatListNumber(14, 'LowerRoman')).toBe('xiv');
    expect(formatListNumber(3, 'UpperLetters')).toBe('C');
    expect(formatListNumber(28, 'LowerLetters')).toBe('ab');
  });
});

describe('drop caps', () => {
  test('the first character is enlarged and the lines beside it are indented', () => {
    const doc = createDocument({ pageSize: 'A5' });
    const style = createParagraphStyle(doc, { name: 'Body', size: 10, leading: 13 });
    const el = doc.findBySelf(style.self)!.element;
    setAttrs(el, { DropCapLines: '3', DropCapCharacters: '1' });
    const frame = textFrame(doc, 'Body', { x: 20, y: 20, width: 280, height: 200 });
    setStoryText(doc, doc.story(frame.getAttribute('ParentStory')!)!, [
      {
        style: 'ParagraphStyle/Body',
        runs: [
          {
            text: 'Once upon a time in a small print shop there lived a typesetter who cared about the shape of every letter and the space between the words on every page of every book.',
          },
        ],
      },
    ]);
    const svg = renderPageSvg(doc, 1).svg;
    const scales = [...svg.matchAll(/matrix\(([\d.]+) 0 0 -[\d.]+ ([\d.-]+) ([\d.-]+)\)/g)].map((m) => ({
      scale: Number(m[1]),
      x: Number(m[2]),
      y: Number(m[3]),
    }));
    const biggest = Math.max(...scales.map((s) => s.scale));
    const body = scales.filter((s) => s.scale < biggest);
    const bodySize = Math.max(...body.map((s) => s.scale));
    expect(biggest).toBeGreaterThan(bodySize * 2.5); // three lines tall
    // the first three lines start to the right of the drop cap
    const dropCap = scales.find((s) => s.scale === biggest)!;
    const firstLines = body.filter((s) => s.y <= dropCap.y).sort((a, b) => a.x - b.x);
    expect(firstLines[0]!.x).toBeGreaterThan(dropCap.x + 10);
  });
});

describe('tab stops', () => {
  test('a right tab with a leader lines the numbers up and fills the gap', () => {
    const doc = createDocument({ pageSize: 'A5' });
    createParagraphStyle(doc, { name: 'Menu', size: 11, leading: 16 });
    setTabStops(resolveStyle(doc, 'ParagraphStyle', 'Menu'), [
      { position: 240, alignment: 'right', leader: '.' },
    ]);
    const frame = textFrame(doc, 'Menu');
    setStoryText(doc, doc.story(frame.getAttribute('ParentStory')!)!, [
      { style: 'ParagraphStyle/Menu', runs: [{ text: 'Espresso\t25' }] },
      { style: 'ParagraphStyle/Menu', runs: [{ text: 'Cappuccino with oat milk\t42' }] },
    ]);
    const svg = renderPageSvg(doc, 1).svg;
    const positions = [...svg.matchAll(/matrix\([\d.]+ 0 0 -[\d.]+ ([\d.-]+) ([\d.-]+)\)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    const rows = new Map<number, number>();
    for (const p of positions) rows.set(p.y, Math.max(rows.get(p.y) ?? 0, p.x));
    const rightmost = [...rows.values()];
    expect(rightmost).toHaveLength(2);
    // both prices end at the same tab stop (within a glyph width)
    expect(Math.abs(rightmost[0]! - rightmost[1]!)).toBeLessThan(2);
    // and the gap is filled with dots
    expect(positions.length).toBeGreaterThan(60);
  });
});

describe('text wrap', () => {
  test('text flows around an object that wraps', () => {
    const build = (wrap: boolean) => {
      const doc = createDocument({ pageSize: 'A5' });
      const frame = textFrame(doc, 'Body', { x: 20, y: 20, width: 280, height: 260 });
      setStoryText(doc, doc.story(frame.getAttribute('ParentStory')!)!, [
        {
          style: '',
          runs: [
            {
              text: 'The quick brown fox jumps over the lazy dog again and again while the typesetter watches the lines fall into place around the picture. '.repeat(
                3,
              ),
            },
          ],
        },
      ]);
      const box = createRectangle(
        doc,
        { page: 1 },
        { rect: { x: 20, y: 60, width: 120, height: 80 }, fill: 'Black', name: 'Box' },
      );
      if (wrap) {
        const pref = firstChild(box, 'TextWrapPreference')!;
        pref.setAttribute('TextWrapMode', 'BoundingBoxTextWrap');
        setAttrs(firstChild(propertiesOf(pref, true), 'TextWrapOffset')!, {
          Top: 6,
          Left: 6,
          Bottom: 6,
          Right: 6,
        });
      }
      return renderPageSvg(doc, 1).svg;
    };
    const plain = build(false);
    const wrapped = build(true);
    // the box in spread coordinates, so the test does not depend on where the page sits
    const boxRect = /<path d="M([\d.-]+) ([\d.-]+)L[^"]*" fill="rgb\(35,31,32\)"\/>/.exec(wrapped);
    expect(boxRect).not.toBeNull();
    const boxX = Number(boxRect![1]);
    const boxY = Number(boxRect![2]);
    const xs = (svg: string) =>
      [...svg.matchAll(/matrix\([\d.]+ 0 0 -[\d.]+ ([\d.-]+) ([\d.-]+)\)/g)].map((m) => ({
        x: Number(m[1]),
        y: Number(m[2]),
      }));
    // in the band beside the box, no glyph may sit inside it when the wrap is on
    const inBox = (points: { x: number; y: number }[]) =>
      points.filter((p) => p.x > boxX + 5 && p.x < boxX + 115 && p.y > boxY + 5 && p.y < boxY + 75).length;
    expect(inBox(xs(plain))).toBeGreaterThan(0);
    expect(inBox(xs(wrapped))).toBe(0);
    // the text is still all there: it just needs more lines
    expect(xs(wrapped).length).toBeGreaterThan(xs(plain).length * 0.8);
  });
});

describe('anchored objects', () => {
  test('an item anchored in text is drawn inline', async () => {
    const doc = createDocument({ pageSize: 'A5' });
    const frame = textFrame(doc, 'Body', { x: 20, y: 20, width: 280, height: 200 });
    const story = doc.story(frame.getAttribute('ParentStory')!)!;
    setStoryText(doc, story, [
      { style: '', runs: [{ text: 'Look at this icon here and then read on to the end of the line.' }] },
    ]);
    const icon = createRectangle(
      doc,
      { page: 1 },
      { rect: { x: 200, y: 300, width: 14, height: 14 }, fill: 'rgb(221,51,17)', name: 'Icon' },
    );
    anchorItem(doc, story, icon, { find: 'icon', position: 'inline' });
    const svg = renderPageSvg(doc, 1).svg;
    expect(svg).toContain('translate(');
    expect(svg).toContain('rgb(221,51,17)');
    // the icon is drawn on the first line of the frame, not at its old place further down
    const { png } = await svgToPng(svg, { width: 500 });
    const raster = decodeRaster(png, 'image/png')!;
    let lowestRed = 0;
    let redPixels = 0;
    for (let i = 0; i < raster.data.length; i += 4) {
      const r = raster.data[i]!;
      const g = raster.data[i + 1]!;
      const b = raster.data[i + 2]!;
      if (r > 180 && g < 110 && b < 90) {
        redPixels++;
        lowestRed = Math.max(lowestRed, Math.floor(i / 4 / raster.width));
      }
    }
    expect(redPixels).toBeGreaterThan(50);
    expect(lowestRed).toBeLessThan(raster.height / 4);
    expect(findItem(doc, 'Icon').info.id).toBeTruthy();
  });
});

describe('page numbers', () => {
  test('an automatic page-number marker shows the page it is drawn on', async () => {
    const doc = createDocument({ pageSize: 'A6', pages: 3 });
    const folio = createTextFrame(
      doc,
      { master: 'A-Master' },
      { rect: { x: 20, y: 260, width: 60, height: 14 }, text: '', name: 'Folio' },
    );
    appendPageNumberMarker(doc.story(folio.getAttribute('ParentStory')!)!, {});
    const glyphCounts = [1, 2, 3].map((page) => {
      const svg = renderPageSvg(doc, page).svg;
      return (svg.match(/<use href="#gl/g) ?? []).length;
    });
    // one digit on every page (the marker resolves, it is not left empty)
    expect(glyphCounts).toEqual([1, 1, 1]);
    // and the three pages draw three different digits (the glyph outlines differ)
    const outlines = [1, 2, 3].map(
      (page) => /<path id="gl[^"]+" d="([^"]*)"/.exec(renderPageSvg(doc, page).svg)?.[1],
    );
    expect(new Set(outlines).size).toBe(3);
  });
});

describe('the sample documents still render', () => {
  test('a bundled reference renders without warnings about missing pieces', async () => {
    const doc = createDocument({ pageSize: 'A4' });
    createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 20, width: 200, height: 60 }, text: 'Sanity', name: 'S' },
    );
    const svg = renderPageSvg(doc, 1);
    expect(svg.warnings).toEqual([]);
    const { png } = await svgToPng(svg.svg, { width: 300 });
    expect(png.length).toBeGreaterThan(100);
    expect(FIXTURES).toBeTruthy();
  });
});

describe('missing glyphs', () => {
  test('a character the font lacks is drawn from a font that has it', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 1 });
    // A family no computer has: it falls back to a bundled face, which carries no symbols, so the
    // character is missing whatever fonts this machine happens to have installed.
    createParagraphStyle(doc, { name: 'Body', font: 'Nonexistent Grotesk', size: 10 });
    createTextFrame(
      doc,
      { page: 1 },
      {
        rect: { x: 20, y: 20, width: 200, height: 40 },
        name: 'Glyphs',
        paragraphs: [{ text: 'a \u25aa b', style: 'ParagraphStyle/Body' }],
      },
    );
    // The fallback can only happen where some installed font actually has the character.
    const available = fontCatalog().faceWithGlyph(0x25aa) !== undefined;
    const r = renderPageSvg(doc, 1);
    // "a ▪ b" is five glyphs; without the per-character fallback the ▪ silently disappeared.
    expect((r.svg.match(/<use /g) ?? []).length).toBe(available ? 5 : 4);
    expect(Object.keys(r.substitutions).some((k) => k.startsWith('\u25aa in '))).toBe(available);
  });
});

describe('masters based on masters', () => {
  test('a page shows the items of the master its master is based on', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 1 });
    // A-Master gets a rule; B-Chapter is based on it and adds a box of its own.
    createRectangle(
      doc,
      { master: 'A-Master' },
      { rect: { x: 10, y: 10, width: 100, height: 4 }, name: 'Rule', fill: 'Black' },
    );
    const made = createMaster(doc, { prefix: 'B', name: 'Chapter', keepItems: false, basedOn: 'A-Master' });
    createRectangle(
      doc,
      { master: made.name },
      { rect: { x: 10, y: 40, width: 40, height: 20 }, name: 'Box', fill: 'Black' },
    );
    const page = doc.findBySelf(findPage(doc, 1).id)?.element;
    page?.setAttribute('AppliedMaster', resolveMaster(doc, made.name)!);

    const svg = renderPageSvg(doc, 1).svg;
    // Both the inherited rule and the chapter master's own box are drawn.
    expect((svg.match(/<path[^>]*fill="rgb\(35,31,32\)"|<path[^>]*fill="rgb\(0,0,0\)"/g) ?? []).length).toBe(
      2,
    );
  });
});

describe('layer stacking', () => {
  test('a new layer goes on top, and master items sit under the page items of their own layer', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 1 });
    // The master's background is on the first layer; a new layer must stack above it.
    createRectangle(
      doc,
      { master: 'A-Master' },
      { rect: { x: 0, y: 0, width: 148, height: 210 }, name: 'Master Ground', fill: 'Black' },
    );
    createLayer(doc, 'Foreground');
    createRectangle(
      doc,
      { page: 1 },
      { rect: { x: 20, y: 20, width: 40, height: 40 }, name: 'Box', fill: 'Paper', layer: 'Foreground' },
    );
    // Top-most first, as InDesign's Layers panel shows them.
    expect(listLayers(doc).map((l) => l.name)).toEqual(['Foreground', 'Layer 1']);

    const svg = renderPageSvg(doc, 1).svg;
    // The box is drawn after the master's ground, so it is visible rather than covered.
    const ground =
      svg.indexOf('rgb(35,31,32)') >= 0 ? svg.indexOf('rgb(35,31,32)') : svg.indexOf('rgb(0,0,0)');
    const box = svg.lastIndexOf('rgb(255,255,255)');
    expect(ground).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(ground);
  });
});

describe('two masters on one spread', () => {
  test('a master item reaching over the spine paints the facing page too', () => {
    const doc = createDocument({ pageSize: 'A6', pages: 3, facingPages: true });
    createSwatch(doc, { name: 'Deep', cmyk: [90, 60, 20, 10] });
    // B's ground covers its right master page and reaches 4mm over the spine.
    const b = createMaster(doc, { prefix: 'B', name: 'Deep', keepItems: false });
    createRectangle(
      doc,
      { master: b.name, masterPage: 'right' },
      { rect: { x: -11.34, y: 0, width: 309, height: 419.5 }, name: 'B Ground R', fill: 'Deep' },
    );
    const c = createMaster(doc, { prefix: 'C', name: 'Plain', keepItems: false });
    const pages = listPages(doc);
    // Pages 2 and 3 share a spread; page 2 takes B, page 3 takes C.
    doc.findBySelf(pages[1]!.id)?.element.setAttribute('AppliedMaster', resolveMaster(doc, b.name)!);
    doc.findBySelf(pages[2]!.id)?.element.setAttribute('AppliedMaster', resolveMaster(doc, c.name)!);

    // InDesign treats an item crossing the spine as belonging to the spread, so page 3 gets it
    // even though C is its master; a preview that clipped strictly per page disagreed.
    const svg = renderPageSvg(doc, 3).svg;
    const [r, g, blue] = cmykToRgb(90, 60, 20, 10);
    expect(svg).toContain(`fill="rgb(${r},${g},${blue})"`);
  });
});

describe('styles InDesign works out while composing', () => {
  test('nested styles run one after another, each through its own delimiter', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 1 });
    createCharacterStyle(doc, { name: 'First', fontStyle: 'Bold' });
    createCharacterStyle(doc, { name: 'Second', fontStyle: 'Italic' });
    createParagraphStyle(doc, { name: 'Body', font: 'Liberation Sans', size: 10 });
    const style = resolveStyle(doc, 'ParagraphStyle', 'Body');
    // "The first two words bold, then everything up to the colon italic."
    setNestedStyles(doc, style, [
      { characterStyle: 'First', through: 'AnyWord', repetition: 2 },
      { characterStyle: 'Second', through: ':', inclusive: false },
    ]);
    const styles = new StyleResolver(doc);
    const runs = styles.applyAutomaticStyles({
      style: 'ParagraphStyle/Body',
      runs: [{ text: 'One two three four: the rest.' }],
    });
    expect(runs.map((r) => [r.text, r.characterStyle?.replace('CharacterStyle/', '')])).toEqual([
      ['One two ', 'First'],
      ['three four', 'Second'],
      [': the rest.', undefined],
    ]);
  });

  test('nested and GREP styles colour the text the preview draws', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 1 });
    createSwatch(doc, { name: 'Signal', cmyk: [0, 100, 100, 0] });
    createCharacterStyle(doc, { name: 'Lead-in', color: 'Signal' });
    createCharacterStyle(doc, { name: 'Acronym', color: 'Signal' });
    const body = createParagraphStyle(doc, { name: 'Body', font: 'Liberation Sans', size: 10 });
    const style = resolveStyle(doc, 'ParagraphStyle', 'Body');
    setNestedStyles(doc, style, [{ characterStyle: 'Lead-in', through: ':', inclusive: false }]);
    setGrepStyles(doc, style, [{ characterStyle: 'Acronym', pattern: '\\b[A-Z]{2,}\\b' }]);
    expect(body.name).toBe('Body');
    createTextFrame(
      doc,
      { page: 1 },
      {
        rect: { x: 10, y: 10, width: 120, height: 40 },
        name: 'T',
        paragraphs: [{ text: 'Lead in: the rest mentions IDML once.', style: 'ParagraphStyle/Body' }],
      },
    );

    // Neither style is in the story — InDesign resolves both as it composes, and so must the preview.
    const svg = renderPageSvg(doc, 1).svg;
    const [r, g, b] = cmykToRgb(0, 100, 100, 0);
    expect(svg).toContain(`fill="rgb(${r},${g},${b})"`);
  });

  test('small caps are set as capitals at a smaller size', () => {
    const doc = createDocument({ pageSize: 'A5', pages: 1 });
    createParagraphStyle(doc, {
      name: 'Caps',
      font: 'Liberation Sans',
      size: 20,
      capitalization: 'small-caps',
    });
    createTextFrame(
      doc,
      { page: 1 },
      {
        rect: { x: 10, y: 10, width: 120, height: 30 },
        name: 'T',
        paragraphs: [{ text: 'Ab', style: 'ParagraphStyle/Caps' }],
      },
    );
    const composer = new Composer(fontCatalog(), new StyleResolver(doc));
    const story = doc.story(attr(findItem(doc, 'T').element, 'ParentStory') ?? '')!;
    const shaped = composer.shapeStory(doc, story);
    const glyphs = shaped.glyphs.filter((g): g is NonNullable<typeof g> => g !== null);
    expect(glyphs.length).toBe(2);
    // The capital keeps the point size; the small capital is set smaller.
    expect(glyphs[0]!.attrs.size).toBe(20);
    expect(glyphs[1]!.attrs.size).toBeLessThan(20);
    expect(glyphs[1]!.char).toBe('B');
  });
});
