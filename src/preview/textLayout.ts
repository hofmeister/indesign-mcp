// A paragraph composer approximating InDesign's single-line composer: resolves cascaded text
// attributes, shapes runs with real font metrics (kerning included), breaks lines to the frame's
// columns, applies alignment/justification, indents, spacing and leading, and flows overflow into
// threaded frames.

import type { GlyphRun } from 'fontkit';
import type { IdmlDocument } from '../idml/document.ts';
import { anchorBounds, readPaths } from '../idml/geometry.ts';
import { type Run, readStory } from '../idml/stories.ts';
import { styleElements } from '../idml/styles.ts';
import { attr, children, type Element, firstChild, getProperty, propertiesOf } from '../idml/xml.ts';
import type { FontCatalog, FontFace, FontMatch } from './fonts.ts';

export interface TextAttrs {
  font: string;
  fontStyle: string;
  size: number;
  /** points, or 'auto' */
  leading: number | 'auto';
  autoLeadingPercent: number;
  tracking: number; // 1/1000 em
  kerning: 'metrics' | 'optical' | 'off';
  fillColor: string;
  fillTint: number | undefined;
  alignment: string;
  spaceBefore: number;
  spaceAfter: number;
  leftIndent: number;
  rightIndent: number;
  firstLineIndent: number;
  hyphenate: boolean;
  capitalization: string;
  underline: boolean;
  strikeThru: boolean;
  horizontalScale: number;
  verticalScale: number;
  baselineShift: number;
  position: string;
  dropCapLines: number;
  dropCapCharacters: number;
  minWordSpacing: number;
  desiredWordSpacing: number;
  maxWordSpacing: number;
  minLetterSpacing: number;
  maxLetterSpacing: number;
  ruleAbove: boolean;
  ruleBelow: boolean;
  /** Bullets and numbering */
  listType: 'none' | 'bullet' | 'number';
  bulletChar: string;
  bulletFont: string | undefined;
  numberExpression: string;
  numberFormat: string;
  numberStartAt: number;
  numberContinue: boolean;
  /** Tab stops, sorted by position (points from the left indent). */
  tabStops: { position: number; alignment: string; leader: string }[];
}

const DEFAULTS: TextAttrs = {
  font: 'Minion Pro',
  fontStyle: 'Regular',
  size: 12,
  leading: 'auto',
  autoLeadingPercent: 120,
  tracking: 0,
  kerning: 'metrics',
  fillColor: 'Color/Black',
  fillTint: undefined,
  alignment: 'LeftAlign',
  spaceBefore: 0,
  spaceAfter: 0,
  leftIndent: 0,
  rightIndent: 0,
  firstLineIndent: 0,
  hyphenate: true,
  capitalization: 'Normal',
  underline: false,
  strikeThru: false,
  horizontalScale: 100,
  verticalScale: 100,
  baselineShift: 0,
  position: 'Normal',
  dropCapLines: 0,
  dropCapCharacters: 0,
  minWordSpacing: 80,
  desiredWordSpacing: 100,
  maxWordSpacing: 133,
  minLetterSpacing: 0,
  maxLetterSpacing: 0,
  ruleAbove: false,
  ruleBelow: false,
  listType: 'none',
  bulletChar: '\u2022',
  bulletFont: undefined,
  numberExpression: '^#.^t',
  numberFormat: 'Arabic',
  numberStartAt: 1,
  numberContinue: true,
  tabStops: [],
};

/** Applies IDML attributes/properties of a style or range element onto `attrs`. */
export function applyElementAttrs(attrs: TextAttrs, el: Element | undefined): TextAttrs {
  if (!el) return attrs;
  const out = { ...attrs };
  const a = (name: string) => attr(el, name);
  const num = (name: string) => {
    const v = a(name);
    return v === undefined ? undefined : Number(v);
  };
  const font = getProperty(el, 'AppliedFont')?.value;
  if (font) out.font = font;
  if (a('FontStyle')) out.fontStyle = a('FontStyle')!;
  if (num('PointSize') !== undefined) out.size = num('PointSize')!;
  const leading = getProperty(el, 'Leading');
  if (leading) out.leading = leading.type === 'enumeration' ? 'auto' : Number(leading.value);
  if (num('AutoLeading') !== undefined) out.autoLeadingPercent = num('AutoLeading')!;
  if (num('Tracking') !== undefined) out.tracking = num('Tracking')!;
  if (a('KerningMethod'))
    out.kerning = /optical/i.test(a('KerningMethod')!)
      ? 'optical'
      : /none/i.test(a('KerningMethod')!)
        ? 'off'
        : 'metrics';
  if (a('FillColor')) out.fillColor = a('FillColor')!;
  if (num('FillTint') !== undefined && num('FillTint')! >= 0) out.fillTint = num('FillTint')!;
  if (a('Justification')) out.alignment = a('Justification')!;
  if (num('SpaceBefore') !== undefined) out.spaceBefore = num('SpaceBefore')!;
  if (num('SpaceAfter') !== undefined) out.spaceAfter = num('SpaceAfter')!;
  if (num('LeftIndent') !== undefined) out.leftIndent = num('LeftIndent')!;
  if (num('RightIndent') !== undefined) out.rightIndent = num('RightIndent')!;
  if (num('FirstLineIndent') !== undefined) out.firstLineIndent = num('FirstLineIndent')!;
  if (a('Hyphenation')) out.hyphenate = a('Hyphenation') === 'true';
  if (a('Capitalization')) out.capitalization = a('Capitalization')!;
  if (a('Underline')) out.underline = a('Underline') === 'true';
  if (a('StrikeThru')) out.strikeThru = a('StrikeThru') === 'true';
  if (num('HorizontalScale') !== undefined) out.horizontalScale = num('HorizontalScale')!;
  if (num('VerticalScale') !== undefined) out.verticalScale = num('VerticalScale')!;
  if (num('BaselineShift') !== undefined) out.baselineShift = num('BaselineShift')!;
  if (a('Position')) out.position = a('Position')!;
  if (num('DropCapLines') !== undefined) out.dropCapLines = num('DropCapLines')!;
  if (num('DropCapCharacters') !== undefined) out.dropCapCharacters = num('DropCapCharacters')!;
  if (num('MinimumWordSpacing') !== undefined) out.minWordSpacing = num('MinimumWordSpacing')!;
  if (num('DesiredWordSpacing') !== undefined) out.desiredWordSpacing = num('DesiredWordSpacing')!;
  if (num('MaximumWordSpacing') !== undefined) out.maxWordSpacing = num('MaximumWordSpacing')!;
  if (num('MinimumLetterSpacing') !== undefined) out.minLetterSpacing = num('MinimumLetterSpacing')!;
  if (num('MaximumLetterSpacing') !== undefined) out.maxLetterSpacing = num('MaximumLetterSpacing')!;
  if (a('RuleAbove')) out.ruleAbove = a('RuleAbove') === 'true';
  if (a('RuleBelow')) out.ruleBelow = a('RuleBelow') === 'true';
  const listType = a('BulletsAndNumberingListType');
  if (listType)
    out.listType = listType === 'BulletList' ? 'bullet' : listType === 'NumberedList' ? 'number' : 'none';
  const props = propertiesOf(el);
  const bullet = props ? firstChild(props, 'BulletChar') : undefined;
  if (bullet) {
    const code = Number(attr(bullet, 'BulletCharacterValue') ?? 0x2022);
    if (Number.isFinite(code) && code > 0) out.bulletChar = String.fromCodePoint(code);
  }
  const bulletFont = getProperty(el, 'BulletsFont')?.value;
  if (bulletFont) out.bulletFont = bulletFont;
  if (a('NumberingExpression')) out.numberExpression = a('NumberingExpression')!;
  const numberFormat = getProperty(el, 'NumberingFormat')?.value;
  if (numberFormat) out.numberFormat = numberFormat;
  if (num('NumberingStartAt') !== undefined) out.numberStartAt = num('NumberingStartAt')!;
  if (a('NumberingContinue')) out.numberContinue = a('NumberingContinue') === 'true';
  const tabList = props ? firstChild(props, 'TabList') : undefined;
  if (tabList) {
    out.tabStops = children(tabList, 'ListItem')
      .map((item) => ({
        position: Number(firstChild(item, 'Position')?.textContent ?? 0),
        alignment: firstChild(item, 'Alignment')?.textContent ?? 'LeftAlign',
        leader: firstChild(item, 'Leader')?.textContent ?? '',
      }))
      .sort((x, y) => x.position - y.position);
  }
  return out;
}

/** Resolves style inheritance (BasedOn chains) for paragraph and character styles. */
export class StyleResolver {
  private para = new Map<string, Element>();
  private char = new Map<string, Element>();
  private cache = new Map<string, TextAttrs>();
  private base: TextAttrs;

  constructor(doc: IdmlDocument) {
    for (const s of styleElements(doc, 'ParagraphStyle')) this.para.set(attr(s.element, 'Self')!, s.element);
    for (const s of styleElements(doc, 'CharacterStyle')) this.char.set(attr(s.element, 'Self')!, s.element);
    // document text defaults
    const textDefault = firstChild(doc.resource('Preferences'), 'TextDefault');
    this.base = applyElementAttrs(DEFAULTS, textDefault);
  }

  private chain(
    map: Map<string, Element>,
    kind: 'ParagraphStyle' | 'CharacterStyle',
    self: string | undefined,
    seen = new Set<string>(),
  ): Element[] {
    if (!self || seen.has(self)) return [];
    seen.add(self);
    const el = map.get(self);
    if (!el) return [];
    const basedOn = getProperty(el, 'BasedOn')?.value;
    let parent: string | undefined;
    if (basedOn) {
      parent = basedOn.startsWith(`${kind}/`) ? basedOn : `${kind}/${basedOn}`;
      if (!map.has(parent)) parent = [...map.keys()].find((k) => attr(map.get(k)!, 'Name') === basedOn);
    }
    return [...this.chain(map, kind, parent, seen), el];
  }

  paragraph(self: string | undefined): TextAttrs {
    const key = `p|${self}`;
    let a = this.cache.get(key);
    if (!a) {
      a = this.base;
      for (const el of this.chain(this.para, 'ParagraphStyle', self)) a = applyElementAttrs(a, el);
      this.cache.set(key, a);
    }
    return a;
  }

  character(paraAttrs: TextAttrs, self: string | undefined): TextAttrs {
    if (!self || self.endsWith('[No character style]')) return paraAttrs;
    let a = paraAttrs;
    for (const el of this.chain(this.char, 'CharacterStyle', self)) a = applyElementAttrs(a, el);
    return a;
  }
}

// ---- shaping -----------------------------------------------------------------------------------

export interface ShapedGlyph {
  glyphId: number;
  /** advance in points (after scaling, tracking) */
  advance: number;
  xOffset: number;
  yOffset: number;
  /** index into the run text */
  charIndex: number;
  char: string;
  face: FontFace;
  attrs: TextAttrs;
  fontKey: string;
  isSpace: boolean;
  /** break opportunity after this glyph */
  breakAfter: boolean;
  hyphenBreak: boolean;
  /** An anchored page item taking the place of a glyph (drawn by the renderer). */
  anchored?: Element;
  /** Height above the baseline for an anchored item. */
  ascentOverride?: number;
  /** Repeating characters filling a tab (a dotted leader, for instance). */
  leader?: ShapedGlyph[];
}

export interface Line {
  glyphs: ShapedGlyph[];
  width: number;
  /** ascent/descent of the tallest font on the line (points) */
  ascent: number;
  descent: number;
  leading: number;
  paragraph: TextAttrs;
  first: boolean;
  last: boolean;
  /** x offset from the column left (alignment + indents) */
  x: number;
  /** extra space per word gap (justification) */
  wordSpacing: number;
  letterSpacing: number;
  /** baseline y relative to the column top */
  baseline: number;
  column: number;
  /** paragraph separator lines (rules) */
  ruleAbove?: boolean;
  hyphenated?: boolean;
  /** Bullet or number drawn in front of the first line of a list paragraph. */
  marker?: ShapedGlyph[];
  markerX?: number;
  /** Enlarged first characters of the paragraph (drop cap). */
  dropCap?: ShapedGlyph[];
  dropCapX?: number;
  /** Baseline of the drop cap, relative to this line's baseline. */
  dropCapBaseline?: number;
}

export interface FrameGeometry {
  width: number;
  height: number;
  columns: number;
  gutter: number;
  inset: { top: number; left: number; bottom: number; right: number };
  verticalJustification: 'TopAlign' | 'CenterAlign' | 'BottomAlign' | 'JustifyAlign';
  firstBaselineOffset: string;
  minFirstBaseline: number;
  /**
   * Areas the text must flow around (other objects' text wrap), in points relative to the
   * top-left corner of the frame's text area (inside the insets).
   */
  exclusions?: { x: number; y: number; width: number; height: number }[];
}

export interface ComposedFrame {
  lines: Line[];
  overset: boolean;
  /** how many glyphs were consumed from the story */
  consumed: number;
}

function applyCapitalization(text: string, cap: string): string {
  if (cap === 'AllCaps' || cap === 'CapToSmallCap') return text.toUpperCase();
  return text;
}

/** The widest free horizontal run between `from` and `to` at a given vertical band. */
function freeSpan(
  exclusions: FrameGeometry['exclusions'],
  from: number,
  to: number,
  top: number,
  bottom: number,
): { start: number; end: number } {
  if (!exclusions?.length) return { start: from, end: to };
  let segments = [{ start: from, end: to }];
  for (const box of exclusions) {
    if (box.y >= bottom || box.y + box.height <= top) continue;
    const next: { start: number; end: number }[] = [];
    for (const seg of segments) {
      if (box.x > seg.start) next.push({ start: seg.start, end: Math.min(seg.end, box.x) });
      if (box.x + box.width < seg.end)
        next.push({ start: Math.max(seg.start, box.x + box.width), end: seg.end });
    }
    segments = next.filter((seg) => seg.end - seg.start > 0.01);
  }
  if (!segments.length) return { start: from, end: from };
  return segments.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
}

const DEFAULT_TAB = 36; // half an inch, InDesign's default tab interval

/** Where the pen lands after a tab at `x` (points from the left indent). */
function nextTabStop(
  x: number,
  stops: TextAttrs['tabStops'],
): { position: number; leader: string; alignment?: string } {
  for (const stop of stops) if (stop.position > x + 0.01) return stop;
  return { position: (Math.floor(x / DEFAULT_TAB) + 1) * DEFAULT_TAB, leader: '' };
}

export class Composer {
  private faceCache = new Map<string, FontMatch>();
  constructor(
    private catalog: FontCatalog,
    private styles: StyleResolver,
  ) {}

  faceFor(attrs: TextAttrs): FontMatch {
    const key = `${attrs.font}|${attrs.fontStyle}`;
    let m = this.faceCache.get(key);
    if (!m) {
      m = this.catalog.match(attrs.font, attrs.fontStyle);
      this.faceCache.set(key, m);
    }
    return m;
  }

  /** Fonts that were replaced by fallbacks during this composer's lifetime. */
  substitutionsUsed(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, m] of this.faceCache) {
      if (m.substituted) out[key.replace('|', ' ').trim()] = m.info.family;
    }
    return out;
  }

  /** Shapes a story into glyphs with paragraph boundaries marked by `null`. */
  shapeStory(
    doc: IdmlDocument,
    story: Element,
    markers: { pageNumber?: string; sectionMarker?: string } = {},
  ): { glyphs: (ShapedGlyph | null)[]; paragraphs: TextAttrs[] } {
    const paragraphs = readStory(story);
    const glyphs: (ShapedGlyph | null)[] = [];
    const paraAttrs: TextAttrs[] = [];
    paragraphs.forEach((para, pi) => {
      const pa = this.styles.paragraph(para.style);
      const pAttrs = applyElementAttrs(pa, para.attrs ? fakeElement(para.attrs) : undefined);
      paraAttrs.push(pAttrs);
      for (const run of para.runs) glyphs.push(...this.shapeRun(resolveMarker(run, markers), pAttrs));
      if (pi < paragraphs.length - 1) glyphs.push(null);
    });
    void doc;
    return { glyphs, paragraphs: paraAttrs };
  }

  /** Repeats a tab's leader character across the width of the tab. */
  private shapeLeader(leader: string, tab: ShapedGlyph, width: number): ShapedGlyph[] | undefined {
    const shaped = this.shapeRun({ text: leader }, tab.attrs);
    const unit = shaped.reduce((sum, g) => sum + g.advance, 0);
    if (!shaped.length || unit <= 0) return undefined;
    const times = Math.floor(width / unit);
    if (times < 1) return undefined;
    const out: ShapedGlyph[] = [];
    for (let i = 0; i < times; i++) out.push(...shaped.map((g) => ({ ...g })));
    return out;
  }

  /** An anchored page item behaves like one wide, tall glyph on the line. */
  private shapeAnchored(item: Element, attrs: TextAttrs, face: FontFace, match: FontMatch): ShapedGlyph {
    const bounds = anchoredItemBounds(item);
    const setting = firstChild(item, 'AnchoredObjectSetting');
    const spaceBefore = setting ? Number(attr(setting, 'AnchorSpaceAbove') ?? 0) || 0 : 0;
    const yOffset = setting ? Number(attr(setting, 'AnchorYoffset') ?? 0) || 0 : 0;
    return {
      glyphId: 0,
      advance: bounds.width,
      xOffset: 0,
      yOffset,
      charIndex: 0,
      char: '\uFFFC',
      face,
      attrs,
      fontKey: `${match.info.path}#${match.info.index}`,
      isSpace: false,
      breakAfter: true,
      hyphenBreak: false,
      anchored: item,
      ascentOverride: bounds.height + spaceBefore,
    };
  }

  shapeRun(run: Run, paraAttrs: TextAttrs): ShapedGlyph[] {
    let attrs = this.styles.character(paraAttrs, run.characterStyle);
    attrs = applyElementAttrs(
      attrs,
      run.attrs || run.props ? fakeElement(run.attrs ?? {}, run.props) : undefined,
    );
    const match = this.faceFor(attrs);
    const face = match.face;
    if (run.anchored) return [this.shapeAnchored(run.anchored, attrs, face, match)];
    const text = applyCapitalization(run.text, attrs.capitalization);
    if (!text) return [];
    const scale = (attrs.size / face.unitsPerEm) * (attrs.horizontalScale / 100);
    const features = attrs.kerning === 'off' ? ['-kern'] : ['kern', 'liga'];
    let glyphRun: GlyphRun;
    try {
      glyphRun = face.layout(text, features);
    } catch {
      glyphRun = face.layout(text);
    }
    const out: ShapedGlyph[] = [];
    const tracking = (attrs.tracking / 1000) * attrs.size;
    const fontKey = `${match.info.path}#${match.info.index}`;
    // Map glyphs back to characters: fontkit gives stringIndices on glyph run positions? Use codePoints of glyphs.
    let charIndex = 0;
    glyphRun.glyphs.forEach((g: GlyphRun['glyphs'][number], i: number) => {
      const pos = glyphRun.positions[i]!;
      const cps = g.codePoints ?? [];
      const ch = cps.length ? String.fromCodePoint(...cps) : (text[charIndex] ?? '');
      const idx = charIndex;
      charIndex += Math.max(1, ch.length);
      const isSpace = /^[\s ]$/.test(ch) && ch !== ' ';
      out.push({
        glyphId: g.id,
        advance: pos.xAdvance * scale + tracking,
        xOffset: pos.xOffset * scale,
        yOffset: pos.yOffset * (attrs.size / face.unitsPerEm) + attrs.baselineShift,
        charIndex: idx,
        char: ch,
        face,
        attrs,
        fontKey,
        isSpace,
        breakAfter: isSpace || ch === ' ' || ch === '-' || ch === '–' || ch === '­',
        hyphenBreak: ch === '­',
      });
    });
    return out;
  }

  /** Line spacing in points for a set of glyphs (the largest leading wins, as in InDesign). */
  private leadingOf(glyphs: ShapedGlyph[], para: TextAttrs): number {
    let lead = 0;
    const consider = (a: TextAttrs) => {
      const l = a.leading === 'auto' ? (a.size * a.autoLeadingPercent) / 100 : a.leading;
      if (l > lead) lead = l;
    };
    if (!glyphs.length) consider(para);
    for (const g of glyphs) {
      consider(g.attrs);
      if (g.ascentOverride !== undefined && g.ascentOverride > lead) lead = g.ascentOverride * 1.05;
    }
    return lead;
  }

  private metrics(glyphs: ShapedGlyph[], para: TextAttrs): { ascent: number; descent: number } {
    let ascent = 0;
    let descent = 0;
    const consider = (face: FontFace, size: number) => {
      const a = (face.ascent / face.unitsPerEm) * size;
      const d = (Math.abs(face.descent) / face.unitsPerEm) * size;
      if (a > ascent) ascent = a;
      if (d > descent) descent = d;
    };
    if (!glyphs.length) consider(this.faceFor(para).face, para.size);
    for (const g of glyphs) {
      consider(g.face, g.attrs.size);
      if (g.ascentOverride !== undefined && g.ascentOverride > ascent) ascent = g.ascentOverride;
    }
    return { ascent, descent };
  }

  /**
   * Breaks shaped glyphs into lines for the frame's columns starting at glyph `start`.
   * Returns the lines that fit and how many glyphs were consumed.
   */
  /** The bullet or number in front of a list paragraph, already shaped. */
  private markerFor(paragraphs: TextAttrs[], index: number): ShapedGlyph[] | undefined {
    const para = paragraphs[index];
    if (!para || para.listType === 'none') return undefined;
    let text: string;
    if (para.listType === 'bullet') {
      text = para.bulletChar;
    } else {
      let n = para.numberStartAt;
      for (let i = index - 1; i >= 0; i--) {
        const previous = paragraphs[i]!;
        if (previous.listType !== 'number') break;
        n++;
        if (!previous.numberContinue) break;
      }
      text = para.numberExpression
        .replace(/\^#/g, formatListNumber(n, para.numberFormat))
        .replace(/\^[tms]/g, '')
        .trim();
    }
    if (!text) return undefined;
    const attrs = para.bulletFont && para.listType === 'bullet' ? { ...para, font: para.bulletFont } : para;
    return this.shapeRun({ text }, attrs);
  }

  compose(
    shaped: (ShapedGlyph | null)[],
    paragraphs: TextAttrs[],
    frame: FrameGeometry,
    start = 0,
    startParagraph = 0,
  ): ComposedFrame {
    const lines: Line[] = [];
    const innerWidth = frame.width - frame.inset.left - frame.inset.right;
    const innerHeight = frame.height - frame.inset.top - frame.inset.bottom;
    const colWidth = (innerWidth - frame.gutter * (frame.columns - 1)) / frame.columns;
    let column = 0;
    let y = 0; // current baseline position within the column (from column top)
    let i = start;
    let paraIndex = startParagraph;
    let firstInColumn = true;
    let overset = false;

    const advanceColumn = (): boolean => {
      column++;
      y = 0;
      firstInColumn = true;
      return column < frame.columns;
    };

    outer: while (i <= shaped.length) {
      const para = paragraphs[paraIndex] ?? paragraphs.at(-1) ?? DEFAULTS;
      // collect paragraph glyphs
      let end = i;
      while (end < shaped.length && shaped[end] !== null) end++;
      const paraGlyphs = shaped.slice(i, end) as ShapedGlyph[];
      let firstLine = true;
      let pos = 0;
      let paraStartedInColumn = false;
      const paraLines: Line[] = [];
      const marker = this.markerFor(paragraphs, paraIndex);
      // Drop cap: take the first characters out of the flow, enlarge them and indent the lines
      // they sit beside.
      let dropCap: ShapedGlyph[] | undefined;
      let dropIndent = 0;
      let dropLines = 0;
      let dropBaselineOffset = 0;
      if (para.dropCapLines > 1 && para.dropCapCharacters > 0 && paraGlyphs.length) {
        const count = Math.min(Math.floor(para.dropCapCharacters), paraGlyphs.length);
        const head = paraGlyphs.slice(0, count);
        const first = head[0]!;
        const leadingHere = this.leadingOf(head, para);
        const capRatio = (first.face.capHeight || first.face.ascent) / first.face.unitsPerEm;
        const target = (para.dropCapLines - 1) * leadingHere + capRatio * first.attrs.size;
        const scale = target / (capRatio * first.attrs.size);
        if (Number.isFinite(scale) && scale > 1) {
          dropCap = head.map((g) => ({
            ...g,
            advance: g.advance * scale,
            xOffset: g.xOffset * scale,
            yOffset: g.yOffset * scale,
            attrs: { ...g.attrs, size: g.attrs.size * scale },
          }));
          dropIndent = dropCap.reduce((sum, g) => sum + g.advance, 0) + first.attrs.size * 0.08;
          dropLines = Math.floor(para.dropCapLines);
          dropBaselineOffset = (para.dropCapLines - 1) * leadingHere;
          paraGlyphs.splice(0, count);
        }
      }
      let lineIndex = 0;
      do {
        const hanging = firstLine && marker !== undefined;
        // A list marker sits at the first-line indent; the text starts at the left indent,
        // as if a tab followed the bullet or number.
        const indentLeft = hanging
          ? para.leftIndent
          : para.leftIndent + (firstLine ? para.firstLineIndent : 0);
        const dropShift = lineIndex < dropLines ? dropIndent : 0;
        // Where the line may sit: the column, minus indents, minus anything wrapping text away.
        const columnLeft = column * (colWidth + frame.gutter);
        const probe = paraGlyphs.slice(pos, pos + 40);
        const probeLead = this.leadingOf(probe, para);
        const probeMetrics = this.metrics(probe, para);
        const probeBaseline = firstInColumn
          ? Math.max(probeMetrics.ascent, frame.minFirstBaseline)
          : y + probeLead + (firstLine && !paraStartedInColumn ? para.spaceBefore : 0);
        const span = freeSpan(
          frame.exclusions,
          columnLeft + indentLeft + dropShift,
          columnLeft + colWidth - para.rightIndent,
          probeBaseline - probeMetrics.ascent,
          probeBaseline + probeMetrics.descent,
        );
        const available = Math.max(1, span.end - span.start);
        const wrapShift = span.start - columnLeft - indentLeft - dropShift;
        if (frame.exclusions?.length && available < Math.min(24, colWidth / 3)) {
          // no usable room on this line: move down one line and try again
          y = probeBaseline;
          firstInColumn = false;
          if (y > innerHeight + 0.01) {
            if (advanceColumn()) continue;
            overset = true;
            break outer;
          }
          continue;
        }
        // greedy fit; tabs are as wide as the distance to the next tab stop
        const tabWidths = new Map<
          number,
          { advance: number; leader: string; alignment: string; position: number }
        >();
        let width = 0;
        let lastBreak = -1;
        let lastBreakWidth = 0;
        let j = pos;
        let forced = false;
        while (j < paraGlyphs.length) {
          const g = paraGlyphs[j]!;
          if (g.char === ' ') {
            forced = true;
            j++;
            break;
          }
          let w = g.advance;
          if (g.char === '\t') {
            const stop = nextTabStop(indentLeft + dropShift + wrapShift + width, para.tabStops);
            w = Math.max(2, stop.position - (indentLeft + dropShift + wrapShift + width));
            tabWidths.set(j, {
              advance: w,
              leader: stop.leader,
              alignment: stop.alignment ?? 'LeftAlign',
              position: stop.position,
            });
          }
          if (width + w > available + 0.01 && j > pos) {
            break;
          }
          width += w;
          if (g.breakAfter) {
            lastBreak = j;
            lastBreakWidth = width;
          }
          j++;
        }
        let lineEnd = j;
        let lineWidth = width;
        let hyphenated = false;
        if (j < paraGlyphs.length && !forced) {
          if (lastBreak >= pos) {
            lineEnd = lastBreak + 1;
            lineWidth = lastBreakWidth;
            hyphenated = paraGlyphs[lastBreak]!.hyphenBreak;
          } else {
            // no break opportunity: hard-break the word
            lineEnd = Math.max(pos + 1, j);
            lineWidth = paraGlyphs.slice(pos, lineEnd).reduce((s, g) => s + g.advance, 0);
          }
        }
        let lineGlyphs = paraGlyphs.slice(pos, lineEnd).map((g, k) => {
          const tab = tabWidths.get(pos + k);
          return tab ? { ...g, advance: tab.advance, breakAfter: true } : g;
        });
        // Right, centre and decimal tabs: shift the tab's width so the text after it lands on
        // the stop, then fill the gap with the leader.
        if (tabWidths.size) {
          let penX = indentLeft + dropShift + wrapShift;
          for (let k = 0; k < lineGlyphs.length; k++) {
            const tab = tabWidths.get(pos + k);
            if (!tab) {
              penX += lineGlyphs[k]!.advance;
              continue;
            }
            if (tab.alignment !== 'LeftAlign') {
              let segment = 0;
              for (let m = k + 1; m < lineGlyphs.length && !tabWidths.has(pos + m); m++) {
                if (tab.alignment === 'CharacterAlign' && /[.,]/.test(lineGlyphs[m]!.char)) break;
                segment += lineGlyphs[m]!.advance;
              }
              const shift = tab.alignment === 'CenterAlign' ? segment / 2 : segment;
              lineGlyphs[k] = { ...lineGlyphs[k]!, advance: Math.max(2, tab.position - penX - shift) };
            }
            const glyph = lineGlyphs[k]!;
            if (tab.leader) {
              lineGlyphs[k] = {
                ...glyph,
                leader: this.shapeLeader(tab.leader, glyph, glyph.advance),
              };
            }
            penX += lineGlyphs[k]!.advance;
          }
          lineWidth = lineGlyphs.reduce((sum, g) => sum + g.advance, 0);
        }
        if (forced && lineGlyphs.at(-1)?.char === ' ') lineGlyphs = lineGlyphs.slice(0, -1);
        // trailing spaces do not count for alignment
        let trimmedWidth = lineWidth;
        let trailing = lineGlyphs.length;
        while (trailing > 0 && lineGlyphs[trailing - 1]!.isSpace) {
          trimmedWidth -= lineGlyphs[trailing - 1]!.advance;
          trailing--;
        }
        const isLast = lineEnd >= paraGlyphs.length;
        const leading = this.leadingOf(lineGlyphs, para);
        const { ascent, descent } = this.metrics(lineGlyphs, para);
        // vertical placement
        let baseline: number;
        if (firstInColumn) {
          switch (frame.firstBaselineOffset) {
            case 'LeadingOffset':
              baseline = Math.max(leading, frame.minFirstBaseline);
              break;
            case 'CapHeight': {
              const cap = lineGlyphs[0]
                ? (lineGlyphs[0].face.capHeight / lineGlyphs[0].face.unitsPerEm) * lineGlyphs[0].attrs.size
                : ascent * 0.7;
              baseline = Math.max(cap, frame.minFirstBaseline);
              break;
            }
            case 'XHeight': {
              const xh = lineGlyphs[0]
                ? (lineGlyphs[0].face.xHeight / lineGlyphs[0].face.unitsPerEm) * lineGlyphs[0].attrs.size
                : ascent * 0.5;
              baseline = Math.max(xh, frame.minFirstBaseline);
              break;
            }
            case 'FixedHeight':
              baseline = Math.max(frame.minFirstBaseline, ascent);
              break;
            default:
              baseline = Math.max(ascent, frame.minFirstBaseline);
          }
          if (!paraStartedInColumn && firstLine && lines.length && column === 0) baseline += 0; // space before ignored at top of frame like InDesign
        } else {
          baseline = y + leading + (firstLine && !paraStartedInColumn ? para.spaceBefore : 0);
        }
        if (
          baseline + descent * 0.0 > innerHeight + 0.01 &&
          !(firstInColumn && baseline <= innerHeight + 0.01)
        ) {
          // does not fit in this column
          if (advanceColumn()) continue; // retry the same line in the next column
          overset = true;
          break outer;
        }
        if (baseline > innerHeight + 0.01) {
          if (advanceColumn()) continue;
          overset = true;
          break outer;
        }
        // alignment
        const align = para.alignment;
        let x = indentLeft + dropShift + wrapShift;
        let wordSpacing = 0;
        let letterSpacing = 0;
        const slack = available - trimmedWidth;
        const justify =
          (align === 'LeftJustified' ||
            align === 'RightJustified' ||
            align === 'CenterJustified' ||
            align === 'FullyJustified') &&
          (!isLast || align === 'FullyJustified') &&
          !forced;
        if (justify) {
          const gaps = lineGlyphs.slice(0, trailing).filter((g) => g.isSpace).length;
          if (gaps > 0) {
            const maxExtra =
              ((para.maxWordSpacing - 100) / 100) * (lineGlyphs.find((g) => g.isSpace)?.advance ?? 3);
            wordSpacing = Math.min(slack / gaps, Math.max(maxExtra * 3, slack / gaps));
            const remaining = slack - wordSpacing * gaps;
            if (remaining > 0.01 && trailing > 1) letterSpacing = remaining / (trailing - 1);
          } else if (trailing > 1) letterSpacing = slack / (trailing - 1);
        } else if (align === 'CenterAlign' || (isLast && align === 'CenterJustified')) x += slack / 2;
        else if (align === 'RightAlign' || (isLast && align === 'RightJustified')) x += slack;
        else if (align === 'ToBindingSide' || align === 'AwayFromBindingSide') x += 0;

        const line: Line = {
          glyphs: lineGlyphs,
          width: trimmedWidth,
          ascent,
          descent,
          leading,
          paragraph: para,
          first: firstLine,
          last: isLast,
          x,
          wordSpacing,
          letterSpacing,
          baseline,
          column,
          hyphenated,
          ruleAbove: firstLine && para.ruleAbove,
          marker: hanging ? marker : undefined,
          markerX: hanging ? para.leftIndent + para.firstLineIndent : undefined,
          dropCap: firstLine ? dropCap : undefined,
          dropCapX: firstLine && dropCap ? indentLeft : undefined,
          dropCapBaseline: firstLine && dropCap ? dropBaselineOffset : undefined,
        };
        paraLines.push(line);
        lines.push(line);
        y = baseline;
        firstInColumn = false;
        paraStartedInColumn = true;
        firstLine = false;
        lineIndex++;
        pos = lineEnd;
        if (isLast) y += para.spaceAfter;
        i = i + pos;
        if (isLast) break;
      } while (pos < paraGlyphs.length);
      // paragraph consumed
      i = end + 1;
      paraIndex++;
      if (end >= shaped.length) break;
    }
    const consumed = Math.min(i, shaped.length);
    // vertical justification
    if (lines.length && frame.verticalJustification !== 'TopAlign') {
      for (let c = 0; c < frame.columns; c++) {
        const col = lines.filter((l) => l.column === c);
        if (!col.length) continue;
        const bottom = col.at(-1)!.baseline + col.at(-1)!.descent;
        const free = innerHeight - bottom;
        if (free <= 0) continue;
        if (frame.verticalJustification === 'CenterAlign') for (const l of col) l.baseline += free / 2;
        else if (frame.verticalJustification === 'BottomAlign') for (const l of col) l.baseline += free;
        else if (frame.verticalJustification === 'JustifyAlign' && col.length > 1) {
          const extra = free / (col.length - 1);
          col.forEach((l, k) => {
            l.baseline += extra * k;
          });
        }
      }
    }
    return { lines, overset, consumed };
  }
}

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

/** Formats a list number the way InDesign's NumberingFormat does. */
export function formatListNumber(n: number, format: string): string {
  const letters = (v: number): string => {
    let out = '';
    let x = v;
    while (x > 0) {
      const r = (x - 1) % 26;
      out = String.fromCharCode(97 + r) + out;
      x = Math.floor((x - 1) / 26);
    }
    return out;
  };
  const roman = (v: number): string => {
    let out = '';
    let x = v;
    for (const [value, sign] of ROMAN) {
      while (x >= value) {
        out += sign;
        x -= value;
      }
    }
    return out;
  };
  switch (format) {
    case 'UpperRoman':
      return roman(n).toUpperCase();
    case 'LowerRoman':
      return roman(n);
    case 'UpperLetters':
      return letters(n).toUpperCase();
    case 'LowerLetters':
      return letters(n);
    default:
      return String(n);
  }
}

/** Size of an anchored item, from its own path (groups use their children). */
function anchoredItemBounds(item: Element): { width: number; height: number } {
  const paths = readPaths(item);
  if (paths.length) {
    const b = anchorBounds(paths);
    return { width: b.width, height: b.height };
  }
  let width = 0;
  let height = 0;
  for (const child of children(item)) {
    const inner = readPaths(child);
    if (!inner.length) continue;
    const b = anchorBounds(inner);
    width = Math.max(width, b.x + b.width);
    height = Math.max(height, b.y + b.height);
  }
  return { width, height };
}

/** Replaces a page-number or section marker with the text InDesign would show there. */
function resolveMarker(run: Run, markers: { pageNumber?: string; sectionMarker?: string }): Run {
  if (!run.marker) return run;
  const text = run.marker === 'page-number' ? (markers.pageNumber ?? '#') : (markers.sectionMarker ?? '');
  return { ...run, text };
}

/** Wraps a plain attribute record (and typed props) in a fake element for applyElementAttrs. */
function fakeElement(
  attrs: Record<string, string>,
  props?: Record<string, { type: string; value: string }>,
): Element {
  const propsChildren = props
    ? Object.entries(props)
        .map(([k, v]) => ({
          tagName: k,
          getAttribute: (n: string) => (n === 'type' ? v.type : null),
          textContent: v.value,
          nodeType: 1,
          firstChild: null,
          nextSibling: null,
        }))
        .map((c, idx, arr) => Object.assign(c, { nextSibling: arr[idx + 1] ?? null }))
    : [];
  const propsEl = props
    ? { tagName: 'Properties', nodeType: 1, firstChild: propsChildren[0] ?? null, nextSibling: null }
    : null;
  return {
    tagName: 'Range',
    nodeType: 1,
    hasAttribute: (n: string) => n in attrs,
    getAttribute: (n: string) => (n in attrs ? attrs[n]! : null),
    firstChild: propsEl,
    attributes: { length: 0, item: () => null },
  } as unknown as Element;
}

export { children, DEFAULTS as TEXT_DEFAULTS };
