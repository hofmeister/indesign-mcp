// Renders IDML spreads/pages to SVG. Text is emitted as glyph outlines from the actual fonts, so
// the result does not depend on the fonts installed where the SVG is rasterized.
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { IdmlDocument } from '../idml/document.ts';
import {
  anchorBounds,
  apply,
  formatMatrix,
  IDENTITY,
  type Matrix,
  multiply,
  type Path,
  parseMatrix,
  type Rect,
  readPaths,
} from '../idml/geometry.ts';
import { graphicChild, isPageItem, itemSpreadBounds, linkUri, linkUriToPath } from '../idml/items.ts';
import { layerElements } from '../idml/layers.ts';
import { findPage, listPages, type PageInfo, pageForSpreadRect } from '../idml/pages.ts';
import { readStoryPlainText, storyHasPageNumberMarker } from '../idml/stories.ts';
import { parseCellName, tableInfo, tablesIn } from '../idml/tables.ts';
import { attr, children, type Element, firstChild, getProperty, numAttr } from '../idml/xml.ts';
import { rgbToCss, SwatchResolver } from './color.ts';
import { fontCatalog } from './fonts.ts';
import {
  Composer,
  type FrameGeometry,
  type Line,
  type ShapedGlyph,
  StyleResolver,
  type TextAttrs,
} from './textLayout.ts';

export interface RenderOptions {
  showGuides?: boolean;
  showFrameEdges?: boolean;
  /** Include the bleed area around the page. */
  bleed?: boolean;
  /** Draw hidden layers too (default false). */
  includeHiddenLayers?: boolean;
}

export interface SvgResult {
  svg: string;
  /** Size of the rendered area in points. */
  width: number;
  height: number;
  warnings: string[];
  substitutions: Record<string, string>;
}

class RenderContext {
  readonly swatches: SwatchResolver;
  readonly composer: Composer;
  readonly defs = new Map<string, string>();
  readonly warnings: string[] = [];
  readonly imageCache = new Map<string, string | undefined>();
  readonly layerOrder = new Map<string, number>();
  readonly hiddenLayers = new Set<string>();
  readonly pages: PageInfo[];
  private composedChains = new Map<string, Map<string, Line[]>>();
  /** Page whose items are being drawn, so page-number markers can resolve. */
  currentPage: PageInfo | undefined;
  private oversetFrames = new Set<string>();
  private idCounter = 0;

  constructor(
    readonly doc: IdmlDocument,
    readonly options: RenderOptions,
  ) {
    this.swatches = new SwatchResolver(doc);
    this.composer = new Composer(fontCatalog(), new StyleResolver(doc));
    this.pages = listPages(doc);
    // designmap lists layers top-most first; draw bottom-most first
    const layers = layerElements(doc);
    layers.forEach((l, i) => {
      this.layerOrder.set(attr(l, 'Self') ?? '', layers.length - i);
      if (attr(l, 'Visible') === 'false') this.hiddenLayers.add(attr(l, 'Self') ?? '');
    });
  }

  nextId(prefix: string): string {
    return `${prefix}${(this.idCounter++).toString(36)}`;
  }

  /** Lines for a text frame, composing its whole thread once. */
  linesFor(frame: Element): { lines: Line[]; overset: boolean } {
    const storyId = attr(frame, 'ParentStory') ?? '';
    const frameId = attr(frame, 'Self') ?? '';
    // A story with a page-number marker composes differently on every page it appears on.
    const story = this.doc.story(storyId);
    const perPage = story ? storyHasPageNumberMarker(story) : false;
    const key = perPage ? `${storyId}|${this.pageNameFor(frame)}` : storyId;
    let chain = this.composedChains.get(key);
    if (!chain) {
      chain = this.composeChain(storyId, frame);
      this.composedChains.set(key, chain);
    }
    return { lines: chain.get(frameId) ?? [], overset: this.oversetFrames.has(frameId) };
  }

  /** Name of the page a frame is drawn on ("4", "iv", "A-1"), for page-number markers. */
  pageNameFor(frame: Element): string {
    if (this.currentPage) return this.currentPage.name;
    const bounds = itemSpreadBounds(frame);
    if (!bounds) return '';
    const page = this.pages.find(
      (p) =>
        bounds.x + bounds.width / 2 >= p.origin.x &&
        bounds.x + bounds.width / 2 <= p.origin.x + p.width &&
        bounds.y + bounds.height / 2 >= p.origin.y &&
        bounds.y + bounds.height / 2 <= p.origin.y + p.height,
    );
    return page?.name ?? '';
  }

  private composeChain(storyId: string, anyFrame: Element): Map<string, Line[]> {
    const result = new Map<string, Line[]>();
    const story = this.doc.story(storyId);
    if (!story) return result;
    // find the head of the thread
    let head = anyFrame;
    const seen = new Set<string>();
    while (
      attr(head, 'PreviousTextFrame') &&
      attr(head, 'PreviousTextFrame') !== 'n' &&
      !seen.has(attr(head, 'Self')!)
    ) {
      seen.add(attr(head, 'Self')!);
      const prev = this.doc.findBySelf(attr(head, 'PreviousTextFrame')!)?.element;
      if (!prev) break;
      head = prev;
    }
    const frames: Element[] = [];
    let cur: Element | undefined = head;
    const seen2 = new Set<string>();
    while (cur && !seen2.has(attr(cur, 'Self')!)) {
      seen2.add(attr(cur, 'Self')!);
      frames.push(cur);
      const next = attr(cur, 'NextTextFrame');
      cur = next && next !== 'n' ? this.doc.findBySelf(next)?.element : undefined;
    }
    let shaped: ReturnType<Composer['shapeStory']>;
    try {
      shaped = this.composer.shapeStory(this.doc, story, {
        pageNumber: this.pageNameFor(anyFrame),
      });
    } catch (e) {
      this.warnings.push(`Text of story ${storyId} could not be shaped: ${(e as Error).message}`);
      return result;
    }
    let start = 0;
    let paraIndex = 0;
    for (const f of frames) {
      const geom = frameGeometry(f);
      geom.exclusions = wrapExclusions(this.doc, f, geom);
      const composed = this.composer.compose(shaped.glyphs, shaped.paragraphs, geom, start, paraIndex);
      result.set(attr(f, 'Self')!, composed.lines);
      // advance: count paragraphs consumed
      for (let k = start; k < composed.consumed && k < shaped.glyphs.length; k++)
        if (shaped.glyphs[k] === null) paraIndex++;
      start = composed.consumed;
      if (!composed.overset) {
        // everything placed; later frames get nothing
        start = shaped.glyphs.length;
      } else if (f === frames.at(-1)) {
        this.oversetFrames.add(attr(f, 'Self')!);
      }
    }
    return result;
  }
}

const WRAP_MODES = new Set(['BoundingBoxTextWrap', 'Contour', 'JumpObjectTextWrap', 'NextColumnTextWrap']);

/**
 * Areas other objects keep clear of the text in this frame (InDesign's text wrap), in points
 * relative to the top-left corner of the frame's text area. Rotated frames are approximated by
 * their bounding boxes.
 */
function wrapExclusions(doc: IdmlDocument, frame: Element, geom: FrameGeometry): Rect[] {
  let container: Element | undefined;
  for (let node = frame.parentNode as Element | null; node; node = node.parentNode as Element | null) {
    if (node.tagName === 'Spread' || node.tagName === 'MasterSpread') {
      container = node;
      break;
    }
  }
  if (!container) return [];
  const frameSpread = itemSpreadBounds(frame);
  const local = anchorBounds(readPaths(frame));
  if (!frameSpread) return [];
  const dx = local.x - frameSpread.x;
  const dy = local.y - frameSpread.y;
  const out: Rect[] = [];
  const visit = (el: Element) => {
    if (!isPageItem(el)) return;
    if (el !== frame) {
      const pref = firstChild(el, 'TextWrapPreference');
      const mode = pref ? attr(pref, 'TextWrapMode') : undefined;
      if (pref && mode && WRAP_MODES.has(mode)) {
        const bounds = itemSpreadBounds(el);
        if (bounds) {
          const offset = firstChild(firstChild(pref, 'Properties'), 'TextWrapOffset');
          const top = offset ? numAttr(offset, 'Top', 0) : 0;
          const left = offset ? numAttr(offset, 'Left', 0) : 0;
          const bottom = offset ? numAttr(offset, 'Bottom', 0) : 0;
          const right = offset ? numAttr(offset, 'Right', 0) : 0;
          const side = attr(pref, 'TextWrapSide');
          // relative to the frame's text area (inside the insets)
          let x = bounds.x + dx - left - local.x - geom.inset.left;
          let width = bounds.width + left + right;
          if (side === 'LeftSide') {
            // text only to the left of the object: block everything from it to the right edge
            width = Math.max(width, geom.width - x);
          } else if (side === 'RightSide') {
            width += x + geom.width;
            x = -geom.width;
          }
          out.push({
            x,
            y: bounds.y + dy - top - local.y - geom.inset.top,
            width,
            height: bounds.height + top + bottom,
          });
        }
      }
    }
    if (el.tagName === 'Group') for (const c of children(el)) visit(c);
  };
  for (const el of children(container)) visit(el);
  void doc;
  return out;
}

function frameGeometry(frame: Element): FrameGeometry {
  const b = anchorBounds(readPaths(frame));
  const pref = firstChild(frame, 'TextFramePreference');
  const insetProp = pref ? getProperty(pref, 'InsetSpacing') : undefined;
  let inset = { top: 0, left: 0, bottom: 0, right: 0 };
  if (pref) {
    const props = firstChild(pref, 'Properties');
    const spacing = props ? firstChild(props, 'InsetSpacing') : undefined;
    if (spacing) {
      const items = children(spacing, 'ListItem').map((li) => Number(li.textContent ?? 0));
      if (items.length === 4)
        inset = { top: items[0]!, left: items[1]!, bottom: items[2]!, right: items[3]! };
      else if (spacing.getAttribute('type') === 'unit') {
        const v = Number(spacing.textContent ?? 0);
        inset = { top: v, left: v, bottom: v, right: v };
      }
    }
  }
  void insetProp;
  const vj = (pref ? attr(pref, 'VerticalJustification') : undefined) as
    | FrameGeometry['verticalJustification']
    | undefined;
  return {
    width: b.width,
    height: b.height,
    columns: pref ? Math.max(1, numAttr(pref, 'TextColumnCount', 1)) : 1,
    gutter: pref ? numAttr(pref, 'TextColumnGutter', 12) : 12,
    inset,
    verticalJustification: vj ?? 'TopAlign',
    firstBaselineOffset: pref ? (attr(pref, 'FirstBaselineOffset') ?? 'AscentOffset') : 'AscentOffset',
    minFirstBaseline: pref ? numAttr(pref, 'MinimumFirstBaselineOffset', 0) : 0,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
}

export function pathToSvg(paths: Path[]): string {
  const parts: string[] = [];
  for (const p of paths) {
    const pts = p.points;
    if (!pts.length) continue;
    parts.push(`M${fmt(pts[0]!.anchor.x)} ${fmt(pts[0]!.anchor.y)}`);
    const n = pts.length;
    const segs = p.open ? n - 1 : n;
    for (let i = 0; i < segs; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      const straight =
        a.right.x === a.anchor.x &&
        a.right.y === a.anchor.y &&
        b.left.x === b.anchor.x &&
        b.left.y === b.anchor.y;
      if (straight) parts.push(`L${fmt(b.anchor.x)} ${fmt(b.anchor.y)}`);
      else
        parts.push(
          `C${fmt(a.right.x)} ${fmt(a.right.y)} ${fmt(b.left.x)} ${fmt(b.left.y)} ${fmt(b.anchor.x)} ${fmt(b.anchor.y)}`,
        );
    }
    if (!p.open) parts.push('Z');
  }
  return parts.join('');
}

/** Rounded-rectangle path when the item has uniform rounded corners (InDesign corner options). */
function cornerAdjustedPath(el: Element, paths: Path[]): string {
  const radius = numAttr(el, 'TopLeftCornerRadius', 0);
  const option = attr(el, 'TopLeftCornerOption');
  if (
    el.tagName !== 'Rectangle' ||
    !radius ||
    !option ||
    option === 'None' ||
    paths.length !== 1 ||
    paths[0]!.points.length !== 4
  )
    return pathToSvg(paths);
  const b = anchorBounds(paths);
  const r = Math.min(radius, b.width / 2, b.height / 2);
  if (option === 'RoundedCorner') {
    return `M${fmt(b.x + r)} ${fmt(b.y)}H${fmt(b.x + b.width - r)}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(b.x + b.width)} ${fmt(b.y + r)}V${fmt(b.y + b.height - r)}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(b.x + b.width - r)} ${fmt(b.y + b.height)}H${fmt(b.x + r)}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(b.x)} ${fmt(b.y + b.height - r)}V${fmt(b.y + r)}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(b.x + r)} ${fmt(b.y)}Z`;
  }
  if (option === 'BevelCorner') {
    return `M${fmt(b.x + r)} ${fmt(b.y)}H${fmt(b.x + b.width - r)}L${fmt(b.x + b.width)} ${fmt(b.y + r)}V${fmt(b.y + b.height - r)}L${fmt(b.x + b.width - r)} ${fmt(b.y + b.height)}H${fmt(b.x + r)}L${fmt(b.x)} ${fmt(b.y + b.height - r)}V${fmt(b.y + r)}Z`;
  }
  return pathToSvg(paths);
}

function strokeDash(type: string | undefined, weight: number): string | undefined {
  if (!type) return undefined;
  const t = type.replace(/^StrokeStyle\/\$ID\//, '').toLowerCase();
  if (t.includes('dash')) return `${fmt(weight * 4)} ${fmt(weight * 3)}`;
  if (t.includes('dotted') || t.includes('dots'))
    return `${fmt(Math.max(0.01, weight * 0.01))} ${fmt(weight * 2)}`;
  return undefined;
}

function paintAttrs(ctx: RenderContext, el: Element, bounds: Rect): { fill: string; stroke: string } {
  const fillPaint = ctx.swatches.resolve(
    attr(el, 'FillColor'),
    el.hasAttribute('FillTint') ? numAttr(el, 'FillTint') : undefined,
  );
  let fill = 'fill="none"';
  if (fillPaint.kind === 'solid' && fillPaint.css) fill = `fill="${fillPaint.css}"`;
  else if (fillPaint.kind === 'gradient' && fillPaint.gradient) {
    const id = ctx.nextId('grad');
    const angle = numAttr(el, 'GradientFillAngle', 0);
    const stops = fillPaint.gradient.stops
      .map(
        (s) => `<stop offset="${fmt(Math.max(0, Math.min(1, s.offset)))}" stop-color="${rgbToCss(s.rgb)}"/>`,
      )
      .join('');
    if (fillPaint.gradient.type === 'radial') {
      ctx.defs.set(
        id,
        `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(bounds.x + bounds.width / 2)}" cy="${fmt(bounds.y + bounds.height / 2)}" r="${fmt(Math.max(bounds.width, bounds.height) / 2)}">${stops}</radialGradient>`,
      );
    } else {
      const rad = (-angle * Math.PI) / 180;
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      const half = Math.max(bounds.width, bounds.height) / 2;
      const x1 = cx - Math.cos(rad) * half;
      const y1 = cy - Math.sin(rad) * half;
      const x2 = cx + Math.cos(rad) * half;
      const y2 = cy + Math.sin(rad) * half;
      ctx.defs.set(
        id,
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}">${stops}</linearGradient>`,
      );
    }
    fill = `fill="url(#${id})"`;
  }
  const weight = numAttr(el, 'StrokeWeight', 0);
  const strokePaint = ctx.swatches.resolve(
    attr(el, 'StrokeColor'),
    el.hasAttribute('StrokeTint') ? numAttr(el, 'StrokeTint') : undefined,
  );
  let stroke = '';
  if (weight > 0 && strokePaint.kind !== 'none' && strokePaint.css) {
    stroke = ` stroke="${strokePaint.css}" stroke-width="${fmt(weight)}"`;
    const dash = strokeDash(attr(el, 'StrokeType'), weight);
    if (dash) stroke += ` stroke-dasharray="${dash}"`;
    const join = attr(el, 'EndJoin');
    if (join === 'RoundEndJoin') stroke += ' stroke-linejoin="round"';
    else if (join === 'BevelEndJoin') stroke += ' stroke-linejoin="bevel"';
  }
  return { fill, stroke };
}

function effectsAttrs(ctx: RenderContext, el: Element): { open: string; close: string } {
  const ts = firstChild(el, 'TransparencySetting');
  if (!ts) return { open: '', close: '' };
  const blending = firstChild(ts, 'BlendingSetting');
  const opacity = blending ? numAttr(blending, 'Opacity', 100) : 100;
  const blendMode = blending ? attr(blending, 'BlendMode') : undefined;
  const shadow = firstChild(ts, 'DropShadowSetting');
  let filter = '';
  if (shadow && attr(shadow, 'Mode') === 'Drop') {
    const distance = numAttr(shadow, 'Distance', 7);
    const angle = numAttr(shadow, 'Angle', 135);
    const size = numAttr(shadow, 'Size', 5);
    const op = numAttr(shadow, 'Opacity', 75) / 100;
    const color = ctx.swatches.resolve(attr(shadow, 'EffectColor') ?? 'Color/Black');
    const dx = Math.cos((angle * Math.PI) / 180) * distance;
    const dy = Math.sin((angle * Math.PI) / 180) * distance;
    const id = ctx.nextId('shadow');
    ctx.defs.set(
      id,
      `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${fmt(dx)}" dy="${fmt(dy)}" stdDeviation="${fmt(size / 2)}" flood-color="${color.css ?? 'rgb(0,0,0)'}" flood-opacity="${fmt(op)}"/></filter>`,
    );
    filter = ` filter="url(#${id})"`;
  }
  const attrs = [
    opacity < 100 ? ` opacity="${fmt(opacity / 100)}"` : '',
    blendMode && blendMode !== 'Normal'
      ? ` style="mix-blend-mode:${blendMode.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}"`
      : '',
    filter,
  ].join('');
  if (!attrs) return { open: '', close: '' };
  return { open: `<g${attrs}>`, close: '</g>' };
}

function imageDataUri(ctx: RenderContext, path: string): string | undefined {
  if (ctx.imageCache.has(path)) return ctx.imageCache.get(path);
  let uri: string | undefined;
  const ext = extname(path).toLowerCase();
  const mime =
    ext === '.png'
      ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.webp'
            ? 'image/webp'
            : undefined;
  if (mime && existsSync(path)) {
    try {
      uri = `data:${mime};base64,${readFileSync(path).toString('base64')}`;
    } catch {
      uri = undefined;
    }
  } else if (existsSync(path)) {
    ctx.warnings.push(
      `${basename(path)}: ${ext || 'this'} format cannot be previewed (PNG/JPEG/GIF/WebP only); shown as a placeholder`,
    );
  } else {
    ctx.warnings.push(`Linked image missing: ${path}`);
  }
  ctx.imageCache.set(path, uri);
  return uri;
}

function renderGraphic(ctx: RenderContext, frame: Element, clipId: string): string {
  const g = graphicChild(frame);
  if (!g) return '';
  const uri = linkUri(frame);
  const path = uri ? linkUriToPath(uri) : undefined;
  const gb = firstChild(firstChild(g, 'Properties'), 'GraphicBounds');
  const left = gb ? numAttr(gb, 'Left', 0) : 0;
  const top = gb ? numAttr(gb, 'Top', 0) : 0;
  const w = gb ? numAttr(gb, 'Right', 0) - left : 0;
  const h = gb ? numAttr(gb, 'Bottom', 0) - top : 0;
  const m = parseMatrix(attr(g, 'ItemTransform'));
  const data = path ? imageDataUri(ctx, path) : undefined;
  if (data && w > 0 && h > 0) {
    return `<g clip-path="url(#${clipId})"><image x="${fmt(left)}" y="${fmt(top)}" width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="none" transform="matrix(${formatMatrix(m)})" href="${data}"/></g>`;
  }
  // placeholder: grey box with a cross and the file name
  const b = anchorBounds(readPaths(frame));
  const label = path ? basename(path) : g.tagName;
  return `<g clip-path="url(#${clipId})"><rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.width)}" height="${fmt(b.height)}" fill="rgb(225,225,225)"/><path d="M${fmt(b.x)} ${fmt(b.y)}L${fmt(b.x + b.width)} ${fmt(b.y + b.height)}M${fmt(b.x + b.width)} ${fmt(b.y)}L${fmt(b.x)} ${fmt(b.y + b.height)}" stroke="rgb(170,170,170)" stroke-width="0.5"/><text x="${fmt(b.x + 4)}" y="${fmt(b.y + b.height - 4)}" font-size="${fmt(Math.max(4, Math.min(9, b.height / 6)))}" fill="rgb(120,120,120)" font-family="sans-serif">${esc(label)}</text></g>`;
}

function glyphDefId(ctx: RenderContext, g: ShapedGlyph): string {
  const key = `g|${g.fontKey}|${g.glyphId}`;
  let id = ctx.defs.get(`#${key}`);
  if (!id) {
    id = ctx.nextId('gl');
    let d = '';
    try {
      d = g.face.getGlyph(g.glyphId).path.toSVG();
    } catch {
      d = '';
    }
    ctx.defs.set(`#${key}`, id);
    ctx.defs.set(id, `<path id="${id}" d="${d}"/>`);
  }
  return id;
}

/** Draws composed lines; (originX, originY) is the top-left of the first text column. */
function renderLines(
  ctx: RenderContext,
  lines: Line[],
  originX: number,
  originY: number,
  colWidth: number,
  gutter: number,
): string {
  const parts: string[] = [];
  for (const line of lines) {
    const colX = originX + line.column * (colWidth + gutter);
    let x = colX + line.x;
    const y = originY + line.baseline;
    let currentFill = '';
    let run: string[] = [];
    const flush = () => {
      if (run.length) parts.push(`<g fill="${currentFill}">${run.join('')}</g>`);
      run = [];
    };
    // drop cap
    if (line.dropCap?.length) {
      let dx = colX + (line.dropCapX ?? 0);
      const dy = y + (line.dropCapBaseline ?? 0);
      for (const g of line.dropCap) {
        if (!g.isSpace && g.glyphId !== 0) {
          const id = glyphDefId(ctx, g);
          const ds = g.attrs.size / g.face.unitsPerEm;
          const paint = ctx.swatches.resolve(g.attrs.fillColor, g.attrs.fillTint);
          parts.push(
            `<g fill="${paint.css ?? 'rgb(0,0,0)'}"><use href="#${id}" transform="matrix(${fmt(ds)} 0 0 ${fmt(-ds)} ${fmt(dx + g.xOffset)} ${fmt(dy)})"/></g>`,
          );
        }
        dx += g.advance;
      }
    }
    // bullet or number in front of a list paragraph
    if (line.marker?.length) {
      let mx = colX + (line.markerX ?? 0);
      for (const g of line.marker) {
        if (!g.isSpace && g.glyphId !== 0) {
          const id = glyphDefId(ctx, g);
          const ms = g.attrs.size / g.face.unitsPerEm;
          const paint = ctx.swatches.resolve(g.attrs.fillColor, g.attrs.fillTint);
          parts.push(
            `<g fill="${paint.css ?? 'rgb(0,0,0)'}"><use href="#${id}" transform="matrix(${fmt(ms)} 0 0 ${fmt(-ms)} ${fmt(mx + g.xOffset)} ${fmt(y)})"/></g>`,
          );
        }
        mx += g.advance;
      }
    }
    // paragraph rules
    if (line.ruleAbove)
      parts.push(
        `<line x1="${fmt(colX)}" y1="${fmt(y - line.ascent - 2)}" x2="${fmt(colX + colWidth)}" y2="${fmt(y - line.ascent - 2)}" stroke="rgb(0,0,0)" stroke-width="1"/>`,
      );
    for (const g of line.glyphs) {
      const paint = ctx.swatches.resolve(g.attrs.fillColor, g.attrs.fillTint);
      const fill = paint.css ?? 'rgb(0,0,0)';
      if (fill !== currentFill) {
        flush();
        currentFill = fill;
      }
      if (g.leader?.length) {
        // a tab with a leader: repeat its characters across the gap, right-aligned to the stop
        const total = g.leader.reduce((sum, l) => sum + l.advance, 0);
        let lx = x + Math.max(0, g.advance - total);
        for (const l of g.leader) {
          if (!l.isSpace && l.glyphId !== 0) {
            const id = glyphDefId(ctx, l);
            const ls = l.attrs.size / l.face.unitsPerEm;
            run.push(
              `<use href="#${id}" transform="matrix(${fmt(ls)} 0 0 ${fmt(-ls)} ${fmt(lx)} ${fmt(y)})"/>`,
            );
          }
          lx += l.advance;
        }
      }
      if (g.anchored) {
        // an anchored object: draw the item where the glyph would have been
        flush();
        const local = anchorBounds(readPaths(g.anchored));
        const height = g.ascentOverride ?? local.height;
        parts.push(
          `<g transform="translate(${fmt(x - local.x)} ${fmt(y + g.yOffset - height - local.y)})">${renderItem(ctx, g.anchored, IDENTITY)}</g>`,
        );
      } else if (!g.isSpace && g.glyphId !== 0) {
        const id = glyphDefId(ctx, g);
        const sx = (g.attrs.size / g.face.unitsPerEm) * (g.attrs.horizontalScale / 100);
        const sy = (g.attrs.size / g.face.unitsPerEm) * (g.attrs.verticalScale / 100);
        let yShift = -g.yOffset;
        if (g.attrs.position === 'Superscript') yShift -= g.attrs.size * 0.33;
        else if (g.attrs.position === 'Subscript') yShift += g.attrs.size * 0.2;
        const scaleFix = g.attrs.position === 'Superscript' || g.attrs.position === 'Subscript' ? 0.583 : 1;
        run.push(
          `<use href="#${id}" transform="matrix(${fmt(sx * scaleFix)} 0 0 ${fmt(-sy * scaleFix)} ${fmt(x + g.xOffset)} ${fmt(y + yShift)})"/>`,
        );
      }
      if (g.attrs.underline) {
        const uy = y + g.attrs.size * 0.12;
        run.push(
          `<rect x="${fmt(x)}" y="${fmt(uy)}" width="${fmt(g.advance + (g.isSpace ? line.wordSpacing : line.letterSpacing))}" height="${fmt(Math.max(0.5, g.attrs.size / 16))}"/>`,
        );
      }
      if (g.attrs.strikeThru) {
        const sy2 = y - g.attrs.size * 0.28;
        run.push(
          `<rect x="${fmt(x)}" y="${fmt(sy2)}" width="${fmt(g.advance)}" height="${fmt(Math.max(0.5, g.attrs.size / 16))}"/>`,
        );
      }
      x += g.advance + (g.isSpace ? line.wordSpacing : letterSpacingFor(line, g));
    }
    if (line.hyphenated) {
      // draw a hyphen after the last glyph of a hyphenated line
      const last = line.glyphs.at(-1);
      if (last) {
        const hyphen = last.face.glyphForCodePoint(0x2d);
        const id = glyphDefId(ctx, { ...last, glyphId: hyphen.id });
        const s = last.attrs.size / last.face.unitsPerEm;
        run.push(`<use href="#${id}" transform="matrix(${fmt(s)} 0 0 ${fmt(-s)} ${fmt(x)} ${fmt(y)})"/>`);
      }
    }
    flush();
  }
  return parts.join('');
}

// ---- tables ---------------------------------------------------------------------------------

interface CellBox {
  cell: Element;
  x: number;
  y: number;
  width: number;
  height: number;
}

function cellInsets(cell: Element): { top: number; left: number; bottom: number; right: number } {
  return {
    top: numAttr(cell, 'TopInset', 4),
    left: numAttr(cell, 'LeftInset', 4),
    bottom: numAttr(cell, 'BottomInset', 4),
    right: numAttr(cell, 'RightInset', 4),
  };
}

function cellGeometry(cell: Element, width: number, height: number): FrameGeometry {
  const inset = cellInsets(cell);
  const vj = attr(cell, 'VerticalJustification') as FrameGeometry['verticalJustification'] | undefined;
  return {
    width,
    height,
    columns: 1,
    gutter: 0,
    inset,
    verticalJustification: vj ?? 'TopAlign',
    firstBaselineOffset: 'AscentOffset',
    minFirstBaseline: 0,
  };
}

/** How tall the cell's text needs the row to be. */
function cellTextHeight(ctx: RenderContext, cell: Element, width: number): number {
  const inset = cellInsets(cell);
  const shaped = ctx.composer.shapeStory(ctx.doc, cell);
  if (!shaped.glyphs.length) return inset.top + inset.bottom;
  const composed = ctx.composer.compose(shaped.glyphs, shaped.paragraphs, cellGeometry(cell, width, 1e6));
  const last = composed.lines.at(-1);
  return inset.top + inset.bottom + (last ? last.baseline + last.descent : 0);
}

function edgeStroke(
  ctx: RenderContext,
  cell: Element,
  side: 'Top' | 'Left' | 'Bottom' | 'Right',
): { weight: number; css: string } | undefined {
  const weight = numAttr(cell, `${side}EdgeStrokeWeight`, 0);
  if (weight <= 0) return undefined;
  const paint = ctx.swatches.resolve(attr(cell, `${side}EdgeStrokeColor`) ?? 'Color/Black');
  if (paint.kind === 'none' || !paint.css) return undefined;
  return { weight, css: paint.css };
}

interface TableGrid {
  info: ReturnType<typeof tableInfo>;
  widths: number[];
  heights: number[];
  positions: Map<Element, { row: number; column: number; rowSpan: number; columnSpan: number }>;
}

/** Column widths and row heights of a table, with rows grown to fit their text (AutoGrow). */
function tableGrid(ctx: RenderContext, table: Element, maxWidth: number): TableGrid {
  const info = tableInfo(table);
  const widths =
    info.columnWidths.length === info.columns
      ? info.columnWidths.map((w) => (w > 0 ? w : maxWidth / Math.max(1, info.columns)))
      : Array.from({ length: info.columns }, () => maxWidth / Math.max(1, info.columns));
  const heights = Array.from({ length: info.rows }, (_, r) => info.rowHeights[r] ?? 0);
  const positions = new Map<Element, { row: number; column: number; rowSpan: number; columnSpan: number }>();
  for (const cell of children(table, 'Cell')) {
    const pos = parseCellName(attr(cell, 'Name'));
    if (!pos) continue;
    positions.set(cell, {
      ...pos,
      rowSpan: Math.max(1, numAttr(cell, 'RowSpan', 1)),
      columnSpan: Math.max(1, numAttr(cell, 'ColumnSpan', 1)),
    });
  }
  for (const [cell, pos] of positions) {
    if (pos.rowSpan !== 1) continue;
    const width = widths.slice(pos.column, pos.column + pos.columnSpan).reduce((a, b) => a + b, 0);
    const needed = cellTextHeight(ctx, cell, width);
    if (needed > (heights[pos.row] ?? 0)) heights[pos.row] = needed;
  }
  return { info, widths, heights, positions };
}

/** How tall a table will be once its rows have grown to fit their text. */
export function measureTableHeight(doc: IdmlDocument, table: Element, maxWidth: number): number {
  const ctx = new RenderContext(doc, {});
  return tableGrid(ctx, table, maxWidth).heights.reduce((a, b) => a + b, 0);
}

/**
 * Draws a table at (x0, y0). Column widths and row heights come from the table; rows grow when
 * their text needs more room, as AutoGrow does in InDesign.
 */
function renderTable(
  ctx: RenderContext,
  table: Element,
  x0: number,
  y0: number,
  maxWidth: number,
): { svg: string; height: number } {
  const { widths, heights, positions, info } = tableGrid(ctx, table, maxWidth);
  if (!info.rows || !info.columns) return { svg: '', height: 0 };
  const xAt = (c: number) => x0 + widths.slice(0, c).reduce((a, b) => a + b, 0);
  const yAt = (r: number) => y0 + heights.slice(0, r).reduce((a, b) => a + b, 0);

  const boxes: CellBox[] = [];
  for (const [cell, pos] of positions) {
    boxes.push({
      cell,
      x: xAt(pos.column),
      y: yAt(pos.row),
      width: widths.slice(pos.column, pos.column + pos.columnSpan).reduce((a, b) => a + b, 0),
      height: heights.slice(pos.row, pos.row + pos.rowSpan).reduce((a, b) => a + b, 0),
    });
  }

  const fills: string[] = [];
  const texts: string[] = [];
  const strokes: string[] = [];
  for (const box of boxes) {
    const fillPaint = ctx.swatches.resolve(
      attr(box.cell, 'FillColor'),
      box.cell.hasAttribute('FillTint') ? numAttr(box.cell, 'FillTint') : undefined,
    );
    if (fillPaint.kind === 'solid' && fillPaint.css)
      fills.push(
        `<rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.width)}" height="${fmt(box.height)}" fill="${fillPaint.css}"/>`,
      );
    const inset = cellInsets(box.cell);
    const shaped = ctx.composer.shapeStory(ctx.doc, box.cell);
    if (shaped.glyphs.length) {
      const composed = ctx.composer.compose(
        shaped.glyphs,
        shaped.paragraphs,
        cellGeometry(box.cell, box.width, box.height),
      );
      texts.push(
        renderLines(
          ctx,
          composed.lines,
          box.x + inset.left,
          box.y + inset.top,
          box.width - inset.left - inset.right,
          0,
        ),
      );
    }
    const edges: [(typeof SIDES)[number], number, number, number, number][] = [
      ['Top', box.x, box.y, box.x + box.width, box.y],
      ['Bottom', box.x, box.y + box.height, box.x + box.width, box.y + box.height],
      ['Left', box.x, box.y, box.x, box.y + box.height],
      ['Right', box.x + box.width, box.y, box.x + box.width, box.y + box.height],
    ];
    for (const [side, x1, y1, x2, y2] of edges) {
      const stroke = edgeStroke(ctx, box.cell, side);
      if (!stroke) continue;
      strokes.push(
        `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="${stroke.css}" stroke-width="${fmt(stroke.weight)}" stroke-linecap="square"/>`,
      );
    }
  }
  // outer border
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  const totalHeight = heights.reduce((a, b) => a + b, 0);
  for (const side of SIDES) {
    const weight = numAttr(table, `${side}BorderStrokeWeight`, 0);
    if (weight <= 0) continue;
    const paint = ctx.swatches.resolve(attr(table, `${side}BorderStrokeColor`) ?? 'Color/Black');
    if (paint.kind === 'none' || !paint.css) continue;
    const [x1, y1, x2, y2] =
      side === 'Top'
        ? [x0, y0, x0 + totalWidth, y0]
        : side === 'Bottom'
          ? [x0, y0 + totalHeight, x0 + totalWidth, y0 + totalHeight]
          : side === 'Left'
            ? [x0, y0, x0, y0 + totalHeight]
            : [x0 + totalWidth, y0, x0 + totalWidth, y0 + totalHeight];
    strokes.push(
      `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="${paint.css}" stroke-width="${fmt(weight)}" stroke-linecap="square"/>`,
    );
  }
  return { svg: [...fills, ...strokes, ...texts].join(''), height: totalHeight };
}

const SIDES = ['Top', 'Bottom', 'Left', 'Right'] as const;

/** Tables of a text frame's story, drawn under the text that precedes them. */
function renderTablesOf(
  ctx: RenderContext,
  frame: Element,
  lines: Line[],
  b: Rect,
  geom: FrameGeometry,
  innerWidth: number,
): string {
  const story = ctx.doc.story(attr(frame, 'ParentStory') ?? '');
  if (!story) return '';
  const tables = tablesIn(story);
  if (!tables.length) return '';
  const lastLine = lines.filter((l) => l.glyphs.length).at(-1);
  let y = b.y + geom.inset.top + (lastLine ? lastLine.baseline + lastLine.descent : 0);
  const parts: string[] = [];
  for (const table of tables) {
    const drawn = renderTable(ctx, table, b.x + geom.inset.left, y, innerWidth);
    parts.push(drawn.svg);
    y += drawn.height;
  }
  return parts.join('');
}

function renderTextFrame(ctx: RenderContext, frame: Element, clipId: string): string {
  const { lines, overset } = ctx.linesFor(frame);
  const b = anchorBounds(readPaths(frame));
  const geom = frameGeometry(frame);
  const innerWidth = geom.width - geom.inset.left - geom.inset.right;
  const colWidth = (innerWidth - geom.gutter * (geom.columns - 1)) / geom.columns;
  const parts: string[] = [`<g clip-path="url(#${clipId})">`];
  parts.push(renderLines(ctx, lines, b.x + geom.inset.left, b.y + geom.inset.top, colWidth, geom.gutter));
  parts.push(renderTablesOf(ctx, frame, lines, b, geom, innerWidth));
  parts.push('</g>');
  if (overset) {
    // InDesign's red overset marker at the out port (bottom right)
    const s = 6;
    const px = b.x + b.width - s - 1;
    const py = b.y + b.height - s - 1;
    parts.push(
      `<g><rect x="${fmt(px)}" y="${fmt(py)}" width="${s}" height="${s}" fill="rgb(255,255,255)" stroke="rgb(220,0,0)" stroke-width="0.75"/><path d="M${fmt(px + 1.5)} ${fmt(py + s / 2)}H${fmt(px + s - 1.5)}M${fmt(px + s / 2)} ${fmt(py + 1.5)}V${fmt(py + s - 1.5)}" stroke="rgb(220,0,0)" stroke-width="0.9"/></g>`,
    );
    ctx.warnings.push(
      `Text frame ${attr(frame, 'Name') && attr(frame, 'Name') !== '$ID/' ? `"${attr(frame, 'Name')}"` : attr(frame, 'Self')} has overset text (does not fit)`,
    );
  }
  return parts.join('');
}

function letterSpacingFor(line: Line, g: ShapedGlyph): number {
  return g === line.glyphs.at(-1) ? 0 : line.letterSpacing;
}

function renderItem(ctx: RenderContext, el: Element, parentTransform: Matrix): string {
  if (!isPageItem(el)) return '';
  if (attr(el, 'Visible') === 'false') return '';
  const layer = attr(el, 'ItemLayer');
  if (layer && ctx.hiddenLayers.has(layer) && !ctx.options.includeHiddenLayers) return '';
  const m = parseMatrix(attr(el, 'ItemTransform'));
  const total = multiply(parentTransform, m);
  if (el.tagName === 'Group') {
    const inner = children(el)
      .filter(isPageItem)
      .map((c) => renderItem(ctx, c, IDENTITY))
      .join('');
    const fx = effectsAttrs(ctx, el);
    return `${fx.open}<g transform="matrix(${formatMatrix(total)})">${inner}</g>${fx.close}`;
  }
  const paths = readPaths(el);
  if (!paths.length) return '';
  const bounds = anchorBounds(paths);
  const d = cornerAdjustedPath(el, paths);
  const { fill, stroke } = paintAttrs(ctx, el, bounds);
  const fx = effectsAttrs(ctx, el);
  const out: string[] = [fx.open, `<g transform="matrix(${formatMatrix(total)})">`];
  const hasGraphic = graphicChild(el) !== undefined;
  const isText = el.tagName === 'TextFrame';
  // fill first
  if (fill !== 'fill="none"' || (!hasGraphic && !isText && stroke === '' && el.tagName !== 'GraphicLine')) {
    out.push(`<path d="${d}" ${fill}/>`);
  }
  if (hasGraphic || isText) {
    const clipId = ctx.nextId('clip');
    ctx.defs.set(clipId, `<clipPath id="${clipId}"><path d="${d}"/></clipPath>`);
    out.push(hasGraphic ? renderGraphic(ctx, el, clipId) : renderTextFrame(ctx, el, clipId));
  }
  if (stroke) out.push(`<path d="${d}" fill="none"${stroke}/>`);
  if (ctx.options.showFrameEdges && (isText || hasGraphic || el.tagName === 'Rectangle')) {
    out.push(
      `<path d="${d}" fill="none" stroke="rgb(90,140,255)" stroke-width="0.4" vector-effect="non-scaling-stroke"/>`,
    );
  }
  out.push('</g>', fx.close);
  return out.join('');
}

function sortedItems(ctx: RenderContext, container: Element): Element[] {
  const items = children(container).filter(isPageItem);
  return items
    .map((el, i) => ({ el, i, layer: ctx.layerOrder.get(attr(el, 'ItemLayer') ?? '') ?? 0 }))
    .sort((a, b) => a.layer - b.layer || a.i - b.i)
    .map((x) => x.el);
}

/** Master page items that belong to `page`, translated into the document spread's coordinates. */
function renderMasterItems(ctx: RenderContext, page: PageInfo): string {
  if (!page.appliedMaster) return '';
  const master = ctx.doc.masterSpreads().find((m) => attr(m, 'Self') === page.appliedMaster);
  if (!master) return '';
  const mpages = children(master, 'Page');
  if (!mpages.length) return '';
  let mp = mpages[0]!;
  if (mpages.length > 1) mp = page.side === 'left' ? mpages[0]! : mpages[mpages.length - 1]!;
  const mb = (attr(mp, 'GeometricBounds') ?? '0 0 0 0').split(/\s+/).map(Number);
  const mt = parseMatrix(attr(mp, 'ItemTransform'));
  const origin = apply(mt, { x: mb[1] ?? 0, y: mb[0] ?? 0 });
  const mpRect: Rect = {
    x: origin.x,
    y: origin.y,
    width: (mb[3] ?? 0) - (mb[1] ?? 0),
    height: (mb[2] ?? 0) - (mb[0] ?? 0),
  };
  const delta: Matrix = [1, 0, 0, 1, page.origin.x - origin.x, page.origin.y - origin.y];
  const overridden = new Set(
    (attr(ctx.doc.findBySelf(page.id)?.element ?? mp, 'OverrideList') ?? '').split(/\s+/).filter(Boolean),
  );
  const out: string[] = [];
  const previousPage = ctx.currentPage;
  ctx.currentPage = page;
  for (const el of sortedItems(ctx, master)) {
    if (overridden.has(attr(el, 'Self') ?? '')) continue;
    const b = anchorBounds(readPaths(el), parseMatrix(attr(el, 'ItemTransform')));
    const cx = b.x + b.width / 2;
    // items belong to the master page they are (mostly) on; items spanning both pages render on both
    if (
      mpages.length > 1 &&
      (cx < mpRect.x - 0.5 || cx > mpRect.x + mpRect.width + 0.5) &&
      !(b.x < mpRect.x + mpRect.width && b.x + b.width > mpRect.x && b.width > mpRect.width * 0.5)
    )
      continue;
    out.push(renderItem(ctx, el, delta));
  }
  ctx.currentPage = previousPage;
  return out.join('');
}

function renderPageBackground(ctx: RenderContext, page: PageInfo, bleed: number): string {
  const out: string[] = [];
  if (bleed > 0) {
    out.push(
      `<rect x="${fmt(page.origin.x - bleed)}" y="${fmt(page.origin.y - bleed)}" width="${fmt(page.width + 2 * bleed)}" height="${fmt(page.height + 2 * bleed)}" fill="none" stroke="rgb(230,60,60)" stroke-width="0.5" stroke-dasharray="2 2"/>`,
    );
  }
  out.push(
    `<rect x="${fmt(page.origin.x)}" y="${fmt(page.origin.y)}" width="${fmt(page.width)}" height="${fmt(page.height)}" fill="rgb(255,255,255)"/>`,
  );
  void ctx;
  return out.join('');
}

function renderGuides(page: PageInfo): string {
  const m = page.margins;
  const x = page.origin.x + m.left;
  const y = page.origin.y + m.top;
  const w = page.width - m.left - m.right;
  const h = page.height - m.top - m.bottom;
  const out = [
    `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="none" stroke="rgb(255,0,255)" stroke-width="0.4"/>`,
  ];
  const cols = page.columns.count;
  if (cols > 1) {
    const colW = (w - page.columns.gutter * (cols - 1)) / cols;
    for (let i = 1; i < cols; i++) {
      const gx = x + i * (colW + page.columns.gutter) - page.columns.gutter;
      out.push(
        `<rect x="${fmt(gx)}" y="${fmt(y)}" width="${fmt(page.columns.gutter)}" height="${fmt(h)}" fill="none" stroke="rgb(120,60,255)" stroke-width="0.3"/>`,
      );
    }
  }
  return out.join('');
}

function bleedOf(doc: IdmlDocument): number {
  const dp = firstChild(doc.resource('Preferences'), 'DocumentPreference');
  return dp ? numAttr(dp, 'DocumentBleedTopOffset', 0) : 0;
}

function assemble(ctx: RenderContext, body: string, view: Rect): SvgResult {
  const defs = [...ctx.defs.entries()]
    .filter(([k]) => !k.startsWith('#'))
    .map(([, v]) => v)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fmt(view.width)}" height="${fmt(view.height)}" viewBox="${fmt(view.x)} ${fmt(view.y)} ${fmt(view.width)} ${fmt(view.height)}"><defs>${defs}</defs>${body}</svg>`;
  const substitutions = ctx.composer.substitutionsUsed();
  return { svg, width: view.width, height: view.height, warnings: [...new Set(ctx.warnings)], substitutions };
}

/** Renders one page (with its master items) to SVG. */
export function renderPageSvg(
  doc: IdmlDocument,
  pageRef: number | string,
  options: RenderOptions = {},
): SvgResult {
  const ctx = new RenderContext(doc, options);
  const page = findPage(doc, pageRef);
  const spread = doc.findBySelf(page.spreadId)?.element;
  if (!spread) throw new Error('Spread not found');
  const bleed = options.bleed ? bleedOf(doc) : 0;
  const parts: string[] = [];
  parts.push(
    `<rect x="${fmt(page.origin.x - bleed - 1)}" y="${fmt(page.origin.y - bleed - 1)}" width="${fmt(page.width + 2 * bleed + 2)}" height="${fmt(page.height + 2 * bleed + 2)}" fill="rgb(255,255,255)"/>`,
  );
  parts.push(renderPageBackground(ctx, page, bleed));
  parts.push(renderMasterItems(ctx, page));
  for (const el of sortedItems(ctx, spread)) parts.push(renderItem(ctx, el, IDENTITY));
  if (options.showGuides) parts.push(renderGuides(page));
  const view: Rect = {
    x: page.origin.x - bleed,
    y: page.origin.y - bleed,
    width: page.width + 2 * bleed,
    height: page.height + 2 * bleed,
  };
  return assemble(ctx, parts.join(''), view);
}

/** Renders a whole spread (all its pages side by side). */
export function renderSpreadSvg(
  doc: IdmlDocument,
  pageRef: number | string,
  options: RenderOptions = {},
): SvgResult {
  const ctx = new RenderContext(doc, options);
  const page = findPage(doc, pageRef);
  const spread = doc.findBySelf(page.spreadId)?.element;
  if (!spread) throw new Error('Spread not found');
  const pages = ctx.pages.filter((p) => p.spreadId === page.spreadId);
  const bleed = options.bleed ? bleedOf(doc) : 0;
  const minX = Math.min(...pages.map((p) => p.origin.x)) - bleed;
  const minY = Math.min(...pages.map((p) => p.origin.y)) - bleed;
  const maxX = Math.max(...pages.map((p) => p.origin.x + p.width)) + bleed;
  const maxY = Math.max(...pages.map((p) => p.origin.y + p.height)) + bleed;
  const parts: string[] = [
    `<rect x="${fmt(minX - 1)}" y="${fmt(minY - 1)}" width="${fmt(maxX - minX + 2)}" height="${fmt(maxY - minY + 2)}" fill="rgb(235,235,235)"/>`,
  ];
  for (const p of pages) parts.push(renderPageBackground(ctx, p, bleed));
  for (const p of pages) parts.push(renderMasterItems(ctx, p));
  for (const el of sortedItems(ctx, spread)) parts.push(renderItem(ctx, el, IDENTITY));
  if (options.showGuides) for (const p of pages) parts.push(renderGuides(p));
  return assemble(ctx, parts.join(''), { x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

/** Renders a zoomed view around one item. */
export function renderItemSvg(
  doc: IdmlDocument,
  itemBounds: Rect,
  pageRef: number | string,
  padding: number,
  options: RenderOptions = {},
): SvgResult {
  const full = renderPageSvg(doc, pageRef, options);
  const page = findPage(doc, pageRef);
  const view: Rect = {
    x: page.origin.x + itemBounds.x - padding,
    y: page.origin.y + itemBounds.y - padding,
    width: itemBounds.width + 2 * padding,
    height: itemBounds.height + 2 * padding,
  };
  const svg = full.svg
    .replace(
      /viewBox="[^"]*"/,
      `viewBox="${fmt(view.x)} ${fmt(view.y)} ${fmt(view.width)} ${fmt(view.height)}"`,
    )
    .replace(/width="[^"]*" height="[^"]*"/, `width="${fmt(view.width)}" height="${fmt(view.height)}"`);
  return { ...full, svg, width: view.width, height: view.height };
}

export interface OversetFrame {
  frame: string;
  name: string | undefined;
  page: number | undefined;
  storyId: string;
  text: string;
}

/** Text frames whose story does not fit (InDesign's red "+" overset marker). */
export function findOversetFrames(doc: IdmlDocument): OversetFrame[] {
  const ctx = new RenderContext(doc, {});
  const out: OversetFrame[] = [];
  const scan = (container: Element) => {
    const spreadId = attr(container, 'Self') ?? '';
    const visit = (el: Element) => {
      if (el.tagName === 'TextFrame') {
        // only the last frame of a thread can be overset
        const next = attr(el, 'NextTextFrame');
        if (!next || next === 'n') {
          let overset = false;
          try {
            overset = ctx.linesFor(el).overset;
          } catch {
            overset = false;
          }
          if (overset) {
            const bounds = itemSpreadBounds(el);
            const page = bounds ? pageForSpreadRect(ctx.pages, spreadId, bounds)?.index : undefined;
            const storyId = attr(el, 'ParentStory') ?? '';
            const story = doc.story(storyId);
            out.push({
              frame: attr(el, 'Self') ?? '',
              name: attr(el, 'Name') && attr(el, 'Name') !== '$ID/' ? attr(el, 'Name') : undefined,
              page,
              storyId,
              text: story ? readStoryPlainText(story).slice(0, 80) : '',
            });
          }
        }
      }
      if (el.tagName === 'Group') for (const c of children(el)) visit(c);
    };
    for (const el of children(container)) visit(el);
  };
  for (const spread of doc.spreads()) scan(spread);
  return out;
}

export type { TextAttrs };
