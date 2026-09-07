// Paragraph/character/object styles (Styles.xml), swatches (Graphic.xml) and fonts (Fonts.xml).
import type { IdmlDocument } from './document.ts';
import { decodeStyleName, displayStyleName, encodeStyleName } from './ids.ts';
import { escapeAttr } from './layers.ts';
import { BASIC_PARAGRAPH_STYLE } from './stories.ts';
import {
  attr,
  children,
  type Element,
  firstChild,
  fragment,
  getProperty,
  insertAfter,
  numAttr,
  setAttrs,
  setProperty,
} from './xml.ts';

export type StyleKind = 'ParagraphStyle' | 'CharacterStyle' | 'ObjectStyle' | 'TableStyle' | 'CellStyle';

const ROOT_GROUP: Record<StyleKind, string> = {
  ParagraphStyle: 'RootParagraphStyleGroup',
  CharacterStyle: 'RootCharacterStyleGroup',
  ObjectStyle: 'RootObjectStyleGroup',
  TableStyle: 'RootTableStyleGroup',
  CellStyle: 'RootCellStyleGroup',
};

export interface StyleInfo {
  self: string;
  name: string;
  group: string | undefined;
  basedOn: string | undefined;
  builtIn: boolean;
  font: string | undefined;
  fontStyle: string | undefined;
  pointSize: number | undefined;
  leading: string | undefined;
  alignment: string | undefined;
  fillColor: string | undefined;
  attributes: Record<string, string>;
}

export function styleElements(
  doc: IdmlDocument,
  kind: StyleKind,
): { element: Element; group: string | undefined }[] {
  const root = firstChild(doc.resource('Styles'), ROOT_GROUP[kind]);
  const out: { element: Element; group: string | undefined }[] = [];
  const walk = (el: Element | undefined, group: string | undefined) => {
    if (!el) return;
    for (const c of children(el)) {
      if (c.tagName === kind) out.push({ element: c, group });
      else if (c.tagName === `${kind}Group`) walk(c, [group, attr(c, 'Name')].filter(Boolean).join('/'));
    }
  };
  walk(root, undefined);
  return out;
}

export function styleInfo(el: Element, group?: string): StyleInfo {
  const attributes: Record<string, string> = {};
  // A built-in style carries every InDesign default explicitly — hundreds of attributes that say
  // nothing about this document and bury the styles someone actually made.
  const builtIn = (attr(el, 'Name') ?? '').startsWith('$ID/');
  for (let i = 0; builtIn ? false : i < el.attributes.length; i++) {
    const a = el.attributes.item(i)!;
    if (
      ![
        'Self',
        'Name',
        'Imported',
        'SplitDocument',
        'EmitCss',
        'StyleUniqueId',
        'IncludeClass',
        'ExtendedKeyboardShortcut',
        'KeyboardShortcut',
        'EmptyNestedStyles',
        'EmptyLineStyles',
        'EmptyGrepStyles',
      ].includes(a.name)
    )
      attributes[a.name] = a.value;
  }
  const leading = getProperty(el, 'Leading');
  const name = attr(el, 'Name') ?? '';
  return {
    self: attr(el, 'Self') ?? '',
    name: displayStyleName(name),
    group,
    // BasedOn holds a reference ("ParagraphStyle/Heading 1") or a built-in's $ID name; report the
    // name a person would recognise either way.
    basedOn: (() => {
      const value = getProperty(el, 'BasedOn')?.value;
      return value === undefined ? undefined : displayStyleName(value);
    })(),
    builtIn: name.startsWith('$ID/'),
    font: getProperty(el, 'AppliedFont')?.value,
    fontStyle: attr(el, 'FontStyle'),
    pointSize: el.hasAttribute('PointSize') ? numAttr(el, 'PointSize') : undefined,
    leading: leading
      ? leading.type === 'enumeration'
        ? leading.value.toLowerCase()
        : leading.value
      : undefined,
    alignment: attr(el, 'Justification'),
    fillColor: attr(el, 'FillColor'),
    attributes,
  };
}

export function listStyles(doc: IdmlDocument, kind: StyleKind): StyleInfo[] {
  return styleElements(doc, kind).map(({ element, group }) => styleInfo(element, group));
}

/** Resolves a style by Self, by display name, or by "Group/Name". Throws with the available names. */
export function resolveStyle(doc: IdmlDocument, kind: StyleKind, ref: string): Element {
  const all = styleElements(doc, kind);
  const lower = ref.toLowerCase();
  const found =
    all.find((s) => attr(s.element, 'Self') === ref) ??
    all.find((s) => attr(s.element, 'Self') === `${kind}/${encodeStyleName(ref)}`) ??
    all.find((s) => displayStyleName(attr(s.element, 'Name') ?? '').toLowerCase() === lower) ??
    all.find((s) => (attr(s.element, 'Name') ?? '').toLowerCase() === lower) ??
    all.find(
      (s) =>
        [s.group, displayStyleName(attr(s.element, 'Name') ?? '')].filter(Boolean).join('/').toLowerCase() ===
        lower,
    );
  if (!found) {
    const names = all.map((s) => displayStyleName(attr(s.element, 'Name') ?? '')).join(', ');
    throw new Error(
      `${kind.replace('Style', ' style').toLowerCase()} "${ref}" not found. Available: ${names}`,
    );
  }
  return found.element;
}

export function styleSelf(doc: IdmlDocument, kind: StyleKind, ref: string): string {
  return attr(resolveStyle(doc, kind, ref), 'Self')!;
}

export const JUSTIFICATION: Record<string, string> = {
  left: 'LeftAlign',
  center: 'CenterAlign',
  centre: 'CenterAlign',
  right: 'RightAlign',
  justify: 'LeftJustified',
  'justify-left': 'LeftJustified',
  'justify-right': 'RightJustified',
  'justify-center': 'CenterJustified',
  'justify-all': 'FullyJustified',
  'full-justify': 'FullyJustified',
  'to-binding': 'ToBindingSide',
  'away-from-binding': 'AwayFromBindingSide',
};

export const CAPITALIZATION: Record<string, string> = {
  normal: 'Normal',
  'small-caps': 'SmallCaps',
  'all-caps': 'AllCaps',
  uppercase: 'AllCaps',
  'cap-to-small-cap': 'CapToSmallCap',
};

export interface TextStyleSpec {
  font?: string;
  fontStyle?: string;
  size?: number;
  /** points, or "auto" */
  leading?: number | 'auto';
  color?: string;
  tracking?: number;
  capitalization?: keyof typeof CAPITALIZATION | string;
  underline?: boolean;
  strikeThrough?: boolean;
  position?: 'normal' | 'superscript' | 'subscript';
  horizontalScale?: number;
  baselineShift?: number;
  /** For character styles the "language" attribute is rarely needed; kept for completeness. */
  extra?: Record<string, string>;
}

export interface ParagraphStyleSpec extends TextStyleSpec {
  name: string;
  basedOn?: string;
  nextStyle?: string;
  group?: string;
  alignment?: keyof typeof JUSTIFICATION | string;
  spaceBefore?: number;
  spaceAfter?: number;
  leftIndent?: number;
  rightIndent?: number;
  firstLineIndent?: number;
  hyphenate?: boolean;
  keepLinesTogether?: boolean;
  dropCapLines?: number;
  dropCapCharacters?: number;
}

export interface CharacterStyleSpec extends TextStyleSpec {
  name: string;
  basedOn?: string;
  group?: string;
}

/**
 * Makes sure Fonts.xml declares a family (and the styles asked of it).
 *
 * InDesign renders a font a document never declares, but everything that reads the file rather
 * than laying it out — packaging, preflight, a font report — works from Fonts.xml, so a document
 * that used Helvetica Neue everywhere still looked like it only used Minion Pro.
 */
export function ensureFontFamily(doc: IdmlDocument, family: string, style = 'Regular'): void {
  const name = family.trim();
  if (!name || name.startsWith('$ID/')) return;
  const fonts = doc.resource('Fonts');
  let fam = children(fonts, 'FontFamily').find(
    (f) => (attr(f, 'Name') ?? '').toLowerCase() === name.toLowerCase(),
  );
  if (!fam) {
    fam = fragment(fonts.ownerDocument!, `<FontFamily Self="${doc.newId()}" Name="${escapeAttr(name)}"/>`);
    fonts.appendChild(fam);
  }
  const wanted = style.trim() || 'Regular';
  const has = children(fam, 'Font').some(
    (f) => (attr(f, 'FontStyleName') ?? '').toLowerCase() === wanted.toLowerCase(),
  );
  if (has) return;
  const full = `${name} ${wanted}`;
  const postScript = `${name.replace(/\s+/g, '')}-${wanted.replace(/\s+/g, '')}`;
  fam.appendChild(
    fragment(
      fonts.ownerDocument!,
      `<Font Self="${escapeAttr(`${attr(fam, 'Self')}Fontn${full}`)}" FontFamily="${escapeAttr(name)}" Name="${escapeAttr(full)}" PostScriptName="${escapeAttr(postScript)}" Status="Installed" FontStyleName="${escapeAttr(wanted)}" FontType="Unknown" WritingScript="0" FullName="${escapeAttr(full)}" FullNameNative="${escapeAttr(full)}" FontStyleNameNative="${escapeAttr(wanted)}" PlatformName="$ID/" Version="$ID/" TypekitID="$ID/"/>`,
    ),
  );
}

/** Translates a TextStyleSpec into IDML attributes + typed properties. */
export function textStyleAttrs(
  doc: IdmlDocument,
  spec: TextStyleSpec,
): {
  attrs: Record<string, string | number | boolean | null>;
  props: Record<string, { type: string; value: string | number } | null>;
} {
  const attrs: Record<string, string | number | boolean | null> = {};
  const props: Record<string, { type: string; value: string | number } | null> = {};
  if (spec.font !== undefined) {
    props.AppliedFont = { type: 'string', value: spec.font };
    ensureFontFamily(doc, spec.font, spec.fontStyle ?? 'Regular');
  }
  if (spec.fontStyle !== undefined) attrs.FontStyle = spec.fontStyle;
  if (spec.size !== undefined) attrs.PointSize = spec.size;
  if (spec.leading !== undefined)
    props.Leading =
      spec.leading === 'auto'
        ? { type: 'enumeration', value: 'Auto' }
        : { type: 'unit', value: spec.leading };
  if (spec.color !== undefined) attrs.FillColor = resolveSwatch(doc, spec.color);
  if (spec.tracking !== undefined) attrs.Tracking = spec.tracking;
  if (spec.capitalization !== undefined)
    attrs.Capitalization = CAPITALIZATION[spec.capitalization.toLowerCase()] ?? spec.capitalization;
  if (spec.underline !== undefined) attrs.Underline = spec.underline;
  if (spec.strikeThrough !== undefined) attrs.StrikeThru = spec.strikeThrough;
  if (spec.position !== undefined)
    attrs.Position = { normal: 'Normal', superscript: 'Superscript', subscript: 'Subscript' }[spec.position];
  if (spec.horizontalScale !== undefined) attrs.HorizontalScale = spec.horizontalScale;
  if (spec.baselineShift !== undefined) attrs.BaselineShift = spec.baselineShift;
  for (const [k, v] of Object.entries(spec.extra ?? {})) attrs[k] = v;
  return { attrs, props };
}

function paragraphAttrs(spec: ParagraphStyleSpec): Record<string, string | number | boolean | null> {
  const a: Record<string, string | number | boolean | null> = {};
  if (spec.alignment !== undefined)
    a.Justification = JUSTIFICATION[spec.alignment.toLowerCase()] ?? spec.alignment;
  if (spec.spaceBefore !== undefined) a.SpaceBefore = spec.spaceBefore;
  if (spec.spaceAfter !== undefined) a.SpaceAfter = spec.spaceAfter;
  if (spec.leftIndent !== undefined) a.LeftIndent = spec.leftIndent;
  if (spec.rightIndent !== undefined) a.RightIndent = spec.rightIndent;
  if (spec.firstLineIndent !== undefined) a.FirstLineIndent = spec.firstLineIndent;
  if (spec.hyphenate !== undefined) a.Hyphenation = spec.hyphenate;
  if (spec.keepLinesTogether !== undefined) a.KeepLinesTogether = spec.keepLinesTogether;
  if (spec.dropCapLines !== undefined) a.DropCapLines = spec.dropCapLines;
  if (spec.dropCapCharacters !== undefined) a.DropCapCharacters = spec.dropCapCharacters;
  return a;
}

function groupContainer(doc: IdmlDocument, kind: StyleKind, group: string | undefined): Element {
  const styles = doc.resource('Styles');
  let root = firstChild(styles, ROOT_GROUP[kind]);
  if (!root) {
    root = fragment(styles.ownerDocument!, `<${ROOT_GROUP[kind]} Self="${doc.newId()}"/>`);
    insertAfter(styles, root);
  }
  if (!group) return root;
  let container = root;
  for (const segment of group.split('/').filter(Boolean)) {
    let g = children(container, `${kind}Group`).find(
      (x) => (attr(x, 'Name') ?? '').toLowerCase() === segment.toLowerCase(),
    );
    if (!g) {
      g = fragment(
        styles.ownerDocument!,
        `<${kind}Group Self="${doc.newId()}" Name="${escapeAttr(segment)}"/>`,
      );
      insertAfter(container, g);
    }
    container = g;
  }
  return container;
}

function newStyleSelf(kind: StyleKind, group: string | undefined, name: string): string {
  const path = [...(group ? group.split('/').filter(Boolean) : []), name].map(encodeStyleName).join('%3a');
  return `${kind}/${path}`;
}

/**
 * How a style records its parent. InDesign writes a built-in parent as its `$ID/` name and a
 * style of the document's own as an object reference; the bare display name it writes for neither
 * is silently unresolvable, and the child then inherits nothing.
 */
function basedOnProperty(parent: Element | undefined, fallback: string): string {
  if (!parent) return `<BasedOn type="string">${escapeAttr(fallback)}</BasedOn>`;
  const name = attr(parent, 'Name') ?? '';
  if (name.startsWith('$ID/')) return `<BasedOn type="string">${escapeAttr(name)}</BasedOn>`;
  return `<BasedOn type="object">${escapeAttr(attr(parent, 'Self') ?? name)}</BasedOn>`;
}

/** Sets BasedOn on an existing style, the same way. */
function setBasedOn(el: Element, parent: Element): void {
  const name = attr(parent, 'Name') ?? '';
  if (name.startsWith('$ID/')) setProperty(el, 'BasedOn', 'string', name);
  else setProperty(el, 'BasedOn', 'object', attr(parent, 'Self') ?? name);
}

export function createParagraphStyle(doc: IdmlDocument, spec: ParagraphStyleSpec): StyleInfo {
  if (
    styleElements(doc, 'ParagraphStyle').some(
      (s) => displayStyleName(attr(s.element, 'Name') ?? '').toLowerCase() === spec.name.toLowerCase(),
    )
  ) {
    throw new Error(`A paragraph style named "${spec.name}" already exists. Use update_style to change it.`);
  }
  const container = groupContainer(doc, 'ParagraphStyle', spec.group);
  const self = newStyleSelf('ParagraphStyle', spec.group, spec.name);
  const basedOn = spec.basedOn ? resolveStyle(doc, 'ParagraphStyle', spec.basedOn) : undefined;
  const next = spec.nextStyle ? styleSelf(doc, 'ParagraphStyle', spec.nextStyle) : self;
  const el = fragment(
    container.ownerDocument!,
    `<ParagraphStyle Self="${escapeAttr(self)}" Name="${escapeAttr(spec.name)}" Imported="false" NextStyle="${escapeAttr(next)}" SplitDocument="false" EmitCss="true" IncludeClass="true" EmptyNestedStyles="true" EmptyLineStyles="true" EmptyGrepStyles="true" KeyboardShortcut="0 0"><Properties>${basedOnProperty(basedOn, '$ID/[No paragraph style]')}<PreviewColor type="enumeration">Nothing</PreviewColor></Properties></ParagraphStyle>`,
  );
  applyStyleSpec(doc, el, spec);
  insertAfter(container, el, children(container, 'ParagraphStyle').at(-1));
  return styleInfo(el, spec.group);
}

export function createCharacterStyle(doc: IdmlDocument, spec: CharacterStyleSpec): StyleInfo {
  if (
    styleElements(doc, 'CharacterStyle').some(
      (s) => displayStyleName(attr(s.element, 'Name') ?? '').toLowerCase() === spec.name.toLowerCase(),
    )
  ) {
    throw new Error(`A character style named "${spec.name}" already exists. Use update_style to change it.`);
  }
  const container = groupContainer(doc, 'CharacterStyle', spec.group);
  const self = newStyleSelf('CharacterStyle', spec.group, spec.name);
  const basedOn = spec.basedOn ? resolveStyle(doc, 'CharacterStyle', spec.basedOn) : undefined;
  const el = fragment(
    container.ownerDocument!,
    `<CharacterStyle Self="${escapeAttr(self)}" Name="${escapeAttr(spec.name)}" Imported="false" SplitDocument="false" EmitCss="true" IncludeClass="true" KeyboardShortcut="0 0"><Properties>${basedOnProperty(basedOn, '$ID/[No character style]')}<PreviewColor type="enumeration">Nothing</PreviewColor></Properties></CharacterStyle>`,
  );
  applyStyleSpec(doc, el, spec);
  insertAfter(container, el, children(container, 'CharacterStyle').at(-1));
  return styleInfo(el, spec.group);
}

/** Applies a spec to an existing style element (used by create and update). */
export function applyStyleSpec(
  doc: IdmlDocument,
  el: Element,
  spec: TextStyleSpec & Partial<ParagraphStyleSpec>,
): void {
  const { attrs, props } = textStyleAttrs(doc, spec);
  setAttrs(el, {
    ...attrs,
    ...(el.tagName === 'ParagraphStyle' ? paragraphAttrs(spec as ParagraphStyleSpec) : {}),
  });
  for (const [k, v] of Object.entries(props)) setProperty(el, k, v?.type ?? 'string', v ? v.value : null);
  if (spec.basedOn && el.tagName !== 'ObjectStyle') {
    setBasedOn(el, resolveStyle(doc, el.tagName as StyleKind, spec.basedOn));
  }
  if (spec.nextStyle && el.tagName === 'ParagraphStyle')
    el.setAttribute('NextStyle', styleSelf(doc, 'ParagraphStyle', spec.nextStyle));
}

export function deleteStyle(doc: IdmlDocument, kind: StyleKind, ref: string, replaceWith?: string): void {
  const el = resolveStyle(doc, kind, ref);
  const self = attr(el, 'Self')!;
  if ((attr(el, 'Name') ?? '').startsWith('$ID/')) throw new Error('Built-in styles cannot be deleted');
  const replacement = replaceWith
    ? styleSelf(doc, kind, replaceWith)
    : kind === 'ParagraphStyle'
      ? 'ParagraphStyle/$ID/NormalParagraphStyle'
      : kind === 'CharacterStyle'
        ? 'CharacterStyle/$ID/[No character style]'
        : `${kind}/$ID/[None]`;
  const attrName =
    kind === 'ParagraphStyle'
      ? 'AppliedParagraphStyle'
      : kind === 'CharacterStyle'
        ? 'AppliedCharacterStyle'
        : 'AppliedObjectStyle';
  for (const part of [...doc.storyParts(), ...doc.spreadParts(), ...doc.masterSpreadParts()]) {
    for (const e of Array.from(doc.xml(part).getElementsByTagName('*')) as Element[]) {
      if (e.getAttribute(attrName) === self) e.setAttribute(attrName, replacement);
    }
  }
  el.parentNode?.removeChild(el);
}

// ---- swatches -------------------------------------------------------------------------------

export interface SwatchInfo {
  self: string;
  name: string;
  kind: 'color' | 'gradient' | 'mixed-ink' | 'none' | 'tint';
  model: string | undefined;
  space: string | undefined;
  values: number[];
  /** Approximate sRGB hex for display, e.g. "#ff0000". */
  hex: string | undefined;
  builtIn: boolean;
}

export function swatchElements(doc: IdmlDocument): Element[] {
  return children(doc.resource('Graphic')).filter((c) =>
    ['Color', 'Gradient', 'MixedInk', 'Swatch', 'Tint'].includes(c.tagName),
  );
}

export function swatchInfo(el: Element): SwatchInfo {
  const values = (attr(el, 'ColorValue') ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
  const space = attr(el, 'Space');
  const name = attr(el, 'Name') ?? '';
  return {
    self: attr(el, 'Self') ?? '',
    name: displayStyleName(name),
    kind:
      el.tagName === 'Color'
        ? 'color'
        : el.tagName === 'Gradient'
          ? 'gradient'
          : el.tagName === 'MixedInk'
            ? 'mixed-ink'
            : el.tagName === 'Tint'
              ? 'tint'
              : 'none',
    model: attr(el, 'Model'),
    space,
    values,
    hex: el.tagName === 'Color' ? colorToHex(space, values) : undefined,
    builtIn:
      name.startsWith('$ID/') ||
      ['None', 'Paper', 'Black', 'Registration'].includes(name) ||
      attr(el, 'ColorRemovable') === 'false',
  };
}

export function listSwatches(doc: IdmlDocument): SwatchInfo[] {
  return swatchElements(doc).map(swatchInfo);
}

export function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  const f = (v: number) => Math.round(255 * (1 - Math.min(1, v / 100)) * (1 - Math.min(1, k / 100)));
  return [f(c), f(m), f(y)];
}

export function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const k = 1 - Math.max(rr, gg, bb);
  if (k >= 1) return [0, 0, 0, 100];
  const c = (1 - rr - k) / (1 - k);
  const m = (1 - gg - k) / (1 - k);
  const y = (1 - bb - k) / (1 - k);
  return [c, m, y, k].map((v) => Math.round(v * 100)) as [number, number, number, number];
}

export function colorToHex(space: string | undefined, values: number[]): string | undefined {
  let rgb: [number, number, number] | undefined;
  if (space === 'CMYK' && values.length === 4)
    rgb = cmykToRgb(values[0]!, values[1]!, values[2]!, values[3]!);
  else if (space === 'RGB' && values.length === 3)
    rgb = [values[0]!, values[1]!, values[2]!].map(Math.round) as [number, number, number];
  else if (space === 'LAB' && values.length === 3) rgb = labToRgb(values[0]!, values[1]!, values[2]!);
  if (!rgb) return undefined;
  return `#${rgb.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  let y = (L + 16) / 116;
  let x = a / 500 + y;
  let z = y - b / 200;
  const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = 0.95047 * f(x);
  y = 1.0 * f(y);
  z = 1.08883 * f(z);
  let r = x * 3.2406 + y * -1.5372 + z * -0.4986;
  let g = x * -0.9689 + y * 1.8758 + z * 0.0415;
  let bb = x * 0.0557 + y * -0.204 + z * 1.057;
  const gamma = (v: number) => (v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v);
  r = gamma(r);
  g = gamma(g);
  bb = gamma(bb);
  return [r, g, bb].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)) as [number, number, number];
}

export interface SwatchSpec {
  name?: string;
  cmyk?: [number, number, number, number];
  rgb?: [number, number, number];
  hex?: string;
  spot?: boolean;
}

export function parseColorString(s: string): SwatchSpec | undefined {
  let t = s.trim();
  // "#14342b as Brand Green" names the swatch it creates. Without a name InDesign auto-names it
  // after its values ("R=20 G=52 B=43"), which is unreadable in a real swatch panel.
  let name: string | undefined;
  const named = /^(.*?)\s+as\s+(.+)$/i.exec(t);
  if (named) {
    t = named[1]!.trim();
    name = named[2]!.trim();
  }
  const spec = parseColorValue(t);
  return spec && name ? { ...spec, name } : spec;
}

function parseColorValue(t: string): SwatchSpec | undefined {
  let m = /^#?([0-9a-f]{6})$/i.exec(t);
  if (m) return { hex: `#${m[1]!.toLowerCase()}` };
  m = /^#?([0-9a-f]{3})$/i.exec(t);
  if (m)
    return {
      hex: `#${m[1]!
        .split('')
        .map((c) => c + c)
        .join('')
        .toLowerCase()}`,
    };
  m = /^cmyk\s*\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*\)$/i.exec(t);
  if (m) return { cmyk: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] };
  m = /^rgb\s*\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*\)$/i.exec(t);
  if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])] };
  m = /^C=(\d+)\s*M=(\d+)\s*Y=(\d+)\s*K=(\d+)$/i.exec(t);
  if (m) return { cmyk: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] };
  return undefined;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

export function createSwatch(doc: IdmlDocument, spec: SwatchSpec): SwatchInfo {
  let space: 'CMYK' | 'RGB';
  let values: number[];
  if (spec.cmyk) {
    space = 'CMYK';
    values = spec.cmyk.map((v) => Math.max(0, Math.min(100, v)));
  } else if (spec.rgb) {
    space = 'RGB';
    values = spec.rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  } else if (spec.hex) {
    space = 'RGB';
    values = hexToRgb(spec.hex);
  } else throw new Error('A swatch needs cmyk, rgb or hex values');
  const autoName =
    space === 'CMYK'
      ? `C=${values[0]} M=${values[1]} Y=${values[2]} K=${values[3]}`
      : `R=${values[0]} G=${values[1]} B=${values[2]}`;
  const name = spec.name?.trim() || autoName;
  const existing = swatchElements(doc).find(
    (s) => displayStyleName(attr(s, 'Name') ?? '').toLowerCase() === name.toLowerCase(),
  );
  if (existing) {
    if (spec.name) throw new Error(`A swatch named "${name}" already exists`);
    return swatchInfo(existing);
  }
  const graphic = doc.resource('Graphic');
  const self = `Color/${encodeStyleName(name)}`;
  const groupRef = addToRootColorGroup(doc, self);
  const el = fragment(
    graphic.ownerDocument!,
    `<Color Self="${escapeAttr(self)}" Model="${spec.spot ? 'Spot' : 'Process'}" Space="${space}" ColorValue="${values.join(' ')}" ColorOverride="Normal" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="${escapeAttr(name)}" ColorEditable="true" ColorRemovable="true" Visible="true" SwatchCreatorID="7937"${groupRef ? ` SwatchColorGroupReference="${groupRef}"` : ''}/>`,
  );
  insertAfter(graphic, el, children(graphic, 'Color').at(-1));
  return swatchInfo(el);
}

function addToRootColorGroup(doc: IdmlDocument, swatchSelf: string): string | undefined {
  const group =
    children(doc.root, 'ColorGroup').find((g) => attr(g, 'IsRootColorGroup') === 'true') ??
    children(doc.root, 'ColorGroup')[0];
  if (!group) return undefined;
  const existing = children(group, 'ColorGroupSwatch');
  const first = existing[0];
  const prefix =
    (first ? attr(first, 'Self') : undefined)?.replace(/ColorGroupSwatch.*$/, '') ??
    `${attr(group, 'Self')?.replace(/[^A-Za-z0-9]/g, '') ?? 'u'}`;
  let n = existing.length;
  let self = `${prefix}ColorGroupSwatch${n.toString(16)}`;
  while (doc.ids.has(self)) self = `${prefix}ColorGroupSwatch${(++n).toString(16)}`;
  doc.ids.add(self);
  const el = fragment(
    doc.designmap,
    `<ColorGroupSwatch Self="${self}" SwatchItemRef="${escapeAttr(swatchSelf)}"/>`,
  );
  insertAfter(group, el, existing.at(-1));
  return self;
}

/**
 * Resolves a swatch reference for FillColor/StrokeColor: "none", "paper", a swatch name, a Self,
 * or an inline color ("#ff0000", "cmyk(0,100,100,0)", "rgb(255,0,0)") which creates a swatch on demand.
 */
export function resolveSwatch(doc: IdmlDocument, ref: string): string {
  const t = ref.trim();
  const lower = t.toLowerCase();
  if (lower === 'none' || lower === 'swatch/none' || lower === 'transparent' || lower === '')
    return 'Swatch/None';
  const swatches = swatchElements(doc);
  const bySelf = swatches.find((s) => attr(s, 'Self') === t);
  if (bySelf) return t;
  const byName = swatches.find(
    (s) =>
      displayStyleName(attr(s, 'Name') ?? '').toLowerCase() === lower ||
      (attr(s, 'Name') ?? '').toLowerCase() === lower,
  );
  if (byName) return attr(byName, 'Self')!;
  const spec = parseColorString(t);
  if (spec) {
    // "#14342b as Brand Green" used on a second item must reuse the swatch it made the first time,
    // not fail because the name is taken.
    if (spec.name) {
      const wanted = spec.name.toLowerCase();
      const already = swatches.find(
        (sw) => displayStyleName(attr(sw, 'Name') ?? '').toLowerCase() === wanted,
      );
      if (already) return attr(already, 'Self')!;
    }
    return createSwatch(doc, spec).self;
  }
  const known: Record<string, [number, number, number, number]> = {
    white: [0, 0, 0, 0],
    red: [0, 100, 100, 0],
    green: [100, 0, 100, 0],
    blue: [100, 100, 0, 0],
    cyan: [100, 0, 0, 0],
    magenta: [0, 100, 0, 0],
    yellow: [0, 0, 100, 0],
    orange: [0, 50, 100, 0],
    gray: [0, 0, 0, 50],
    grey: [0, 0, 0, 50],
  };
  if (lower === 'paper' || lower === 'white')
    return swatches.find((s) => attr(s, 'Self') === 'Color/Paper')
      ? 'Color/Paper'
      : createSwatch(doc, { name: 'White', cmyk: known.white }).self;
  if (known[lower])
    return createSwatch(doc, { name: lower[0]!.toUpperCase() + lower.slice(1), cmyk: known[lower] }).self;
  const names = swatches.map((s) => displayStyleName(attr(s, 'Name') ?? '')).join(', ');
  throw new Error(
    `Unknown swatch or color "${ref}". Use a swatch name (${names}), "none", a hex color like #ff6600, or cmyk(0,60,100,0).`,
  );
}

// ---- fonts ------------------------------------------------------------------------------------

export interface FontInfo {
  family: string;
  styles: string[];
  status: string | undefined;
}

export function listFonts(doc: IdmlDocument): FontInfo[] {
  const fonts = doc.resource('Fonts');
  return children(fonts, 'FontFamily').map((fam) => ({
    family: attr(fam, 'Name') ?? '',
    styles: children(fam, 'Font').map((f) => attr(f, 'FontStyleName') ?? ''),
    status: children(fam, 'Font')[0] ? attr(children(fam, 'Font')[0]!, 'Status') : undefined,
  }));
}

/** Fonts referenced by styles and text but not listed in Fonts.xml (informational). */
/**
 * Fonts the document actually asks for: every font named in a story, plus the fonts of the styles
 * those stories and items apply (and the styles those are based on).
 *
 * Styles nobody uses are left out on purpose. A blank template defines [Basic Paragraph] in Minion
 * Pro, and counting it makes every new document report a missing font it never referenced.
 */
export function fontsUsed(doc: IdmlDocument): Set<string> {
  const used = new Set<string>();
  const addFontsIn = (el: Element): void => {
    for (const f of Array.from(el.getElementsByTagName('AppliedFont'))) {
      const v = f.textContent?.trim();
      if (v) used.add(v);
    }
  };

  // Fonts named directly in the text, and the styles the text and the page items apply.
  const applied = new Set<string>();
  const styleAttrs = ['AppliedParagraphStyle', 'AppliedCharacterStyle', 'AppliedObjectStyle'];
  const collect = (el: Element): void => {
    for (const name of styleAttrs) {
      const v = attr(el, name);
      if (v) applied.add(v);
    }
    for (const c of children(el)) collect(c);
  };
  for (const part of doc.storyParts()) {
    const xml = doc.xml(part);
    if (!xml.documentElement) continue;
    addFontsIn(xml.documentElement);
    collect(xml.documentElement);
  }
  for (const spread of [...doc.spreads(), ...doc.masterSpreads()]) collect(spread);

  // A style that is applied brings the styles it is based on with it.
  const stylesPart = doc.partRefs('Styles')[0]?.src ?? 'Resources/Styles.xml';
  const styleXml = doc.xml(stylesPart);
  const byId = new Map<string, Element>();
  const index = (el: Element): void => {
    const self = attr(el, 'Self');
    if (self && /Style$/.test(el.tagName)) byId.set(self, el);
    for (const c of children(el)) index(c);
  };
  if (styleXml.documentElement) index(styleXml.documentElement);
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const el = byId.get(id);
    if (!el) return;
    addFontsIn(el);
    for (const name of ['BasedOn', 'NextStyle', 'AppliedCharacterStyle']) {
      const ref = attr(el, name);
      if (ref) visit(ref);
    }
  };
  for (const id of applied) visit(id);
  return used;
}

export { decodeStyleName, displayStyleName };

// ---- object styles ------------------------------------------------------------------------------

export interface ObjectStyleSpec {
  name: string;
  basedOn?: string;
  fill?: string;
  fillTint?: number;
  stroke?: string;
  strokeWeight?: number;
  strokeType?: string;
  strokeAlignment?: 'center' | 'inside' | 'outside';
  cornerRadius?: number;
  cornerShape?: 'rounded' | 'inverse-rounded' | 'bevel' | 'inset' | 'fancy' | 'none';
  opacity?: number;
  paragraphStyle?: string;
  /** Text frame options applied by the style. */
  columns?: number;
  gutter?: number;
  inset?: number;
  verticalJustification?: 'top' | 'center' | 'bottom' | 'justify';
  textWrap?: 'none' | 'bounding-box';
  textWrapOffset?: number;
}

const CORNER_OPTIONS: Record<string, string> = {
  rounded: 'RoundedCorner',
  'inverse-rounded': 'InverseRoundedCorner',
  bevel: 'BevelCorner',
  inset: 'InsetCorner',
  fancy: 'FancyCorner',
  none: 'None',
};

/** Attributes an object style writes onto the items that use it. */
export function objectStyleAttrs(
  doc: IdmlDocument,
  spec: ObjectStyleSpec,
): Record<string, string | number | boolean | null> {
  const a: Record<string, string | number | boolean | null> = {};
  if (spec.fill !== undefined) a.FillColor = resolveSwatch(doc, spec.fill);
  if (spec.fillTint !== undefined) a.FillTint = spec.fillTint;
  if (spec.stroke !== undefined) a.StrokeColor = resolveSwatch(doc, spec.stroke);
  if (spec.strokeWeight !== undefined) a.StrokeWeight = spec.strokeWeight;
  if (spec.strokeType) a.StrokeType = `StrokeStyle/$ID/${spec.strokeType}`;
  if (spec.strokeAlignment) {
    a.StrokeAlignment = { center: 'CenterAlignment', inside: 'InsideAlignment', outside: 'OutsideAlignment' }[
      spec.strokeAlignment
    ];
  }
  if (spec.cornerRadius !== undefined) {
    const option = CORNER_OPTIONS[spec.cornerShape ?? 'rounded'] ?? 'RoundedCorner';
    for (const corner of ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight']) {
      a[`${corner}CornerOption`] = option;
      a[`${corner}CornerRadius`] = spec.cornerRadius;
    }
  }
  if (spec.paragraphStyle) a.AppliedParagraphStyle = styleSelf(doc, 'ParagraphStyle', spec.paragraphStyle);
  return a;
}

function objectStyleChildren(spec: ObjectStyleSpec): string {
  const parts: string[] = [];
  if (
    spec.columns !== undefined ||
    spec.gutter !== undefined ||
    spec.inset !== undefined ||
    spec.verticalJustification
  ) {
    const vj = spec.verticalJustification
      ? { top: 'TopAlign', center: 'CenterAlign', bottom: 'BottomAlign', justify: 'JustifyAlign' }[
          spec.verticalJustification
        ]
      : 'TopAlign';
    const inset = spec.inset ?? 0;
    parts.push(
      `<TextFramePreference TextColumnCount="${Math.max(1, Math.floor(spec.columns ?? 1))}" TextColumnGutter="${spec.gutter ?? 12}" VerticalJustification="${vj}"><Properties><InsetSpacing type="list"><ListItem type="unit">${inset}</ListItem><ListItem type="unit">${inset}</ListItem><ListItem type="unit">${inset}</ListItem><ListItem type="unit">${inset}</ListItem></InsetSpacing></Properties></TextFramePreference>`,
    );
  }
  if (spec.textWrap) {
    const o = spec.textWrapOffset ?? 0;
    parts.push(
      `<TextWrapPreference Inverse="false" ApplyToMasterPageOnly="false" TextWrapSide="BothSides" TextWrapMode="${spec.textWrap === 'none' ? 'None' : 'BoundingBoxTextWrap'}"><Properties><TextWrapOffset Top="${o}" Left="${o}" Bottom="${o}" Right="${o}"/></Properties></TextWrapPreference>`,
    );
  }
  if (spec.opacity !== undefined) {
    parts.push(
      `<TransparencySetting><BlendingSetting Opacity="${Math.max(0, Math.min(100, spec.opacity))}" BlendMode="Normal"/></TransparencySetting>`,
    );
  }
  return parts.join('');
}

export function createObjectStyle(doc: IdmlDocument, spec: ObjectStyleSpec): StyleInfo {
  if (
    styleElements(doc, 'ObjectStyle').some(
      (s) => displayStyleName(attr(s.element, 'Name') ?? '').toLowerCase() === spec.name.toLowerCase(),
    )
  ) {
    throw new Error(`An object style named "${spec.name}" already exists. Use update_style to change it.`);
  }
  const styles = doc.resource('Styles');
  let root = firstChild(styles, 'RootObjectStyleGroup');
  if (!root) {
    root = fragment(styles.ownerDocument!, `<RootObjectStyleGroup Self="${doc.newId()}"/>`);
    insertAfter(styles, root);
  }
  const self = `ObjectStyle/${encodeStyleName(spec.name)}`;
  // An object style's parent is a reference, like every other object-typed property; the display
  // name InDesign cannot resolve, and the child then inherits nothing.
  const basedOn = spec.basedOn
    ? (attr(resolveStyle(doc, 'ObjectStyle', spec.basedOn), 'Self') ?? '$ID/[None]')
    : '$ID/[None]';
  const enable = [
    spec.fill !== undefined ? 'EnableFill="true"' : 'EnableFill="false"',
    spec.stroke !== undefined || spec.strokeWeight !== undefined
      ? 'EnableStroke="true"'
      : 'EnableStroke="false"',
    spec.paragraphStyle ? 'EnableParagraphStyle="true"' : 'EnableParagraphStyle="false"',
    spec.columns !== undefined || spec.inset !== undefined || spec.verticalJustification
      ? 'EnableTextFrameGeneralOptions="true"'
      : 'EnableTextFrameGeneralOptions="false"',
    spec.textWrap ? 'EnableTextWrapAndOthers="true"' : 'EnableTextWrapAndOthers="false"',
    spec.cornerRadius !== undefined ? 'EnableStrokeAndCornerOptions="true"' : '',
    spec.opacity !== undefined ? 'EnableFillTransparencySettings="true"' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const el = fragment(
    styles.ownerDocument!,
    `<ObjectStyle Self="${escapeAttr(self)}" Name="${escapeAttr(spec.name)}" ${enable} EmitCss="true" IncludeClass="true" ExtendedKeyboardShortcut="0 0 0"><Properties><BasedOn type="object">${escapeAttr(basedOn)}</BasedOn></Properties>${objectStyleChildren(spec)}</ObjectStyle>`,
  );
  setAttrs(el, objectStyleAttrs(doc, spec));
  insertAfter(root, el, children(root, 'ObjectStyle').at(-1));
  return styleInfo(el);
}

export function updateObjectStyle(
  doc: IdmlDocument,
  ref: string,
  spec: Omit<ObjectStyleSpec, 'name'>,
): StyleInfo {
  const el = resolveStyle(doc, 'ObjectStyle', ref);
  setAttrs(el, objectStyleAttrs(doc, { ...spec, name: ref }));
  const extra = objectStyleChildren({ ...spec, name: ref });
  if (extra) {
    for (const tag of ['TextFramePreference', 'TextWrapPreference', 'TransparencySetting']) {
      const existing = firstChild(el, tag);
      if (existing) el.removeChild(existing);
    }
    const frag = fragment(el.ownerDocument!, `<Wrapper>${extra}</Wrapper>`);
    for (const c of children(frag)) el.appendChild(c.cloneNode(true));
  }
  return styleInfo(el);
}

/**
 * Applies an object style to an item: sets AppliedObjectStyle and copies the style's own
 * attributes onto the item, which is what InDesign writes when a style is applied.
 */
export function applyObjectStyle(doc: IdmlDocument, item: Element, ref: string): string {
  const style = resolveStyle(doc, 'ObjectStyle', ref);
  const self = attr(style, 'Self')!;
  item.setAttribute('AppliedObjectStyle', self);
  // A style based on another carries only its own differences, so the chain is applied parent
  // first: without it a style based on a panel loses the panel's inset and paragraph style.
  for (const parent of objectStyleChain(doc, style)) applyObjectStyleLevel(doc, item, parent);
  applyObjectStyleLevel(doc, item, style);
  return self;
}

/** The styles a given object style is based on, oldest ancestor first. */
function objectStyleChain(doc: IdmlDocument, style: Element): Element[] {
  const chain: Element[] = [];
  const seen = new Set<string>([attr(style, 'Self') ?? '']);
  let current = style;
  for (;;) {
    const ref = getProperty(current, 'BasedOn')?.value;
    if (!ref || ref.startsWith('$ID/')) break;
    let parent: Element;
    try {
      parent = resolveStyle(doc, 'ObjectStyle', ref);
    } catch {
      break;
    }
    const id = attr(parent, 'Self') ?? '';
    if (seen.has(id)) break;
    seen.add(id);
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/** Copies one object style's own settings onto an item. */
function applyObjectStyleLevel(doc: IdmlDocument, item: Element, style: Element): void {
  const COPY = [
    'FillColor',
    'FillTint',
    'StrokeColor',
    'StrokeTint',
    'StrokeWeight',
    'StrokeType',
    'StrokeAlignment',
    'TopLeftCornerOption',
    'TopRightCornerOption',
    'BottomLeftCornerOption',
    'BottomRightCornerOption',
    'TopLeftCornerRadius',
    'TopRightCornerRadius',
    'BottomLeftCornerRadius',
    'BottomRightCornerRadius',
  ];
  for (const a of COPY) {
    const v = attr(style, a);
    if (v !== undefined) item.setAttribute(a, v);
  }
  for (const tag of ['TextFramePreference', 'TextWrapPreference', 'TransparencySetting']) {
    const src = firstChild(style, tag);
    if (!src) continue;
    if (tag === 'TextFramePreference' && item.tagName !== 'TextFrame') continue;
    const existing = firstChild(item, tag);
    const clone = item.ownerDocument!.importNode(src, true) as Element;
    if (existing) item.replaceChild(clone, existing);
    else item.appendChild(clone);
  }
  const para = attr(style, 'AppliedParagraphStyle');
  if (para && item.tagName === 'TextFrame') {
    const storyId = attr(item, 'ParentStory');
    const story = storyId ? doc.story(storyId) : undefined;
    // InDesign only lets an object style's paragraph style reach text that is still
    // unstyled — paragraphs given a style of their own keep it.
    if (story)
      for (const psr of Array.from(story.getElementsByTagName('ParagraphStyleRange')) as Element[]) {
        const current = attr(psr, 'AppliedParagraphStyle');
        if (current && current !== BASIC_PARAGRAPH_STYLE) continue;
        psr.setAttribute('AppliedParagraphStyle', para);
      }
  }
}

// ---- gradients ----------------------------------------------------------------------------------

export interface GradientSpec {
  name: string;
  type?: 'linear' | 'radial';
  /** Two or more colours; each is a swatch name or an inline colour. */
  stops: { color: string; location?: number; midpoint?: number }[];
}

export function createGradient(doc: IdmlDocument, spec: GradientSpec): SwatchInfo {
  if (spec.stops.length < 2) throw new Error('A gradient needs at least two colours');
  const existing = swatchElements(doc).find(
    (s) => displayStyleName(attr(s, 'Name') ?? '').toLowerCase() === spec.name.toLowerCase(),
  );
  if (existing) throw new Error(`A swatch named "${spec.name}" already exists`);
  const graphic = doc.resource('Graphic');
  const self = `Gradient/${encodeStyleName(spec.name)}`;
  const stops = spec.stops.map((s, i) => {
    const color = resolveSwatch(doc, s.color);
    const location = s.location ?? (i / (spec.stops.length - 1)) * 100;
    return `<GradientStop Self="${doc.newId()}" StopColor="${escapeAttr(color)}" Location="${Math.max(0, Math.min(100, location))}" Midpoint="${s.midpoint ?? 50}"/>`;
  });
  const el = fragment(
    graphic.ownerDocument!,
    `<Gradient Self="${escapeAttr(self)}" Type="${spec.type === 'radial' ? 'Radial' : 'Linear'}" Name="${escapeAttr(spec.name)}" ColorEditable="true" ColorRemovable="true" Visible="true" SwatchCreatorID="7937">${stops.join('')}</Gradient>`,
  );
  // Graphic.xml has a fixed order — colours, inks, mixed inks, tints, swatches, then gradients —
  // and a gradient dropped in after the colours puts everything after it out of order.
  const BEFORE_GRADIENT = [
    'Color',
    'Ink',
    'MixedInkGroup',
    'MixedInk',
    'PastedSmoothShade',
    'Tint',
    'Swatch',
  ];
  const previous =
    children(graphic, 'Gradient').at(-1) ??
    children(graphic)
      .filter((c) => BEFORE_GRADIENT.includes(c.tagName))
      .at(-1);
  insertAfter(graphic, el, previous);
  return swatchInfo(el);
}

/** Sets the gradient geometry (angle and length) of an item's fill. */
export function setGradientFillGeometry(
  item: Element,
  options: { angle?: number; length?: number; startX?: number; startY?: number },
): void {
  if (options.angle !== undefined) item.setAttribute('GradientFillAngle', String(options.angle));
  if (options.length !== undefined) item.setAttribute('GradientFillLength', String(options.length));
  if (options.startX !== undefined || options.startY !== undefined) {
    item.setAttribute('GradientFillStart', `${options.startX ?? 0} ${options.startY ?? 0}`);
  }
}
