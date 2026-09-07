// Bullets and numbering, tab stops, hyperlinks, section numbering, anchored objects and the
// special characters InDesign users expect to be able to type.
import type { IdmlDocument } from './document.ts';
import { anchorBounds, readPaths } from './geometry.ts';
import { isPageItem } from './items.ts';
import { escapeAttr } from './layers.ts';
import { findPage, listPages } from './pages.ts';
import { NO_CHARACTER_STYLE } from './stories.ts';
import { resolveStyle, styleSelf } from './styles.ts';
import {
  attr,
  children,
  type Element,
  firstChild,
  formatNumber,
  fragment,
  insertAfter,
  ownerDoc,
  propertiesOf,
  removeElement,
  setProperty,
} from './xml.ts';

// ---- bullets and numbering ----------------------------------------------------------------------

export interface ListSpec {
  kind: 'none' | 'bullet' | 'number';
  /** The bullet character (default •). */
  bulletCharacter?: string;
  /** Numbering pattern, e.g. "^#." for "1.", "^#)" for "1)". */
  numberFormat?: string;
  numberStyle?: 'arabic' | 'upper-roman' | 'lower-roman' | 'upper-letters' | 'lower-letters';
  startAt?: number;
  /** Text between the bullet/number and the paragraph, default a tab. */
  textAfter?: string;
  alignment?: 'left' | 'center' | 'right';
  /** Indent of the paragraph and of the bullet/number, in points. */
  indent?: number;
  bulletIndent?: number;
  characterStyle?: string;
  font?: string;
  /** Style of the bullet font, e.g. "Bold"; default Regular. */
  fontStyle?: string;
}

/**
 * The numbering pattern InDesign stores. `textAfter` is appended to the format rather than
 * replacing it, so `numberFormat: "^#."` with `textAfter: "^t"` yields "^#.^t".
 */
function numberingExpression(spec: ListSpec): string {
  const format = spec.numberFormat ?? '^#.';
  const after = spec.textAfter ?? '^t';
  return after && !format.endsWith(after) ? format + after : format;
}

const NUMBER_STYLE: Record<string, string> = {
  arabic: 'Arabic',
  'upper-roman': 'UpperRoman',
  'lower-roman': 'LowerRoman',
  'upper-letters': 'UpperLetters',
  'lower-letters': 'LowerLetters',
};

/** Applies bullet or numbering settings to a paragraph style (or a paragraph range). */
export function applyListSettings(doc: IdmlDocument, el: Element, spec: ListSpec): void {
  const type = spec.kind === 'bullet' ? 'BulletList' : spec.kind === 'number' ? 'NumberedList' : 'NoList';
  el.setAttribute('BulletsAndNumberingListType', type);
  if (spec.kind === 'none') {
    for (const name of [
      'BulletChar',
      'NumberingFormat',
      'BulletsFont',
      'BulletsFontStyle',
      'BulletsCharacterStyle',
      'NumberingCharacterStyle',
    ]) {
      const props = propertiesOf(el);
      const existing = props ? firstChild(props, name) : undefined;
      if (existing) removeElement(existing);
    }
    return;
  }
  const alignment = { left: 'LeftAlign', center: 'CenterAlign', right: 'RightAlign' }[
    spec.alignment ?? 'left'
  ];
  if (spec.kind === 'bullet') {
    el.setAttribute('BulletsAlignment', alignment);
    el.setAttribute('BulletsTextAfter', spec.textAfter ?? '^t');
    const char = spec.bulletCharacter ?? '•';
    const code = char.codePointAt(0) ?? 0x2022;
    const props = propertiesOf(el, true);
    const existing = firstChild(props, 'BulletChar');
    if (existing) removeElement(existing);
    const bullet = fragment(
      ownerDoc(el),
      `<BulletChar BulletCharacterType="UnicodeOnly" BulletCharacterValue="${code}"/>`,
    );
    props.appendChild(bullet);
    // InDesign writes the bullet font as a plain string (family name) plus a style;
    // an object reference here is silently ignored and the bullet keeps the text font.
    if (spec.font) {
      setProperty(el, 'BulletsFont', 'string', spec.font);
      setProperty(el, 'BulletsFontStyle', 'string', spec.fontStyle ?? 'Regular');
    }
    if (spec.characterStyle)
      setProperty(
        el,
        'BulletsCharacterStyle',
        'object',
        styleSelf(doc, 'CharacterStyle', spec.characterStyle),
      );
  } else {
    el.setAttribute('NumberingAlignment', alignment);
    el.setAttribute('NumberingStartAt', String(spec.startAt ?? 1));
    el.setAttribute('NumberingContinue', 'true');
    el.setAttribute('NumberingLevel', '1');
    el.setAttribute('NumberingExpression', numberingExpression(spec));
    setProperty(el, 'NumberingFormat', 'string', NUMBER_STYLE[spec.numberStyle ?? 'arabic'] ?? 'Arabic');
    if (spec.characterStyle)
      setProperty(
        el,
        'NumberingCharacterStyle',
        'object',
        styleSelf(doc, 'CharacterStyle', spec.characterStyle),
      );
  }
  if (spec.indent !== undefined) el.setAttribute('LeftIndent', formatNumber(spec.indent));
  if (spec.bulletIndent !== undefined)
    el.setAttribute('FirstLineIndent', formatNumber(-Math.abs(spec.bulletIndent)));
}

// ---- tab stops -----------------------------------------------------------------------------------

export interface TabStop {
  position: number;
  alignment?: 'left' | 'center' | 'right' | 'decimal';
  /** Character to fill the space before the tab, e.g. "." for a dotted leader. */
  leader?: string;
  /** Character to align on when alignment is "decimal" (default "."). */
  alignOn?: string;
}

export function setTabStops(el: Element, stops: TabStop[]): void {
  const props = propertiesOf(el, true);
  const existing = firstChild(props, 'TabList');
  if (existing) removeElement(existing);
  if (!stops.length) return;
  const items = stops
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const align = {
        left: 'LeftAlign',
        center: 'CenterAlign',
        right: 'RightAlign',
        decimal: 'CharacterAlign',
      }[s.alignment ?? 'left'];
      return `<ListItem type="record"><Alignment type="enumeration">${align}</Alignment><AlignmentCharacter type="string">${escapeAttr(s.alignOn ?? '.')}</AlignmentCharacter><Leader type="string">${escapeAttr(s.leader ?? '')}</Leader><Position type="unit">${formatNumber(s.position)}</Position></ListItem>`;
    });
  props.appendChild(fragment(ownerDoc(el), `<TabList type="list">${items.join('')}</TabList>`));
}

export function readTabStops(el: Element): TabStop[] {
  const props = propertiesOf(el);
  const list = props ? firstChild(props, 'TabList') : undefined;
  if (!list) return [];
  return children(list, 'ListItem').map((item) => ({
    position: Number(firstChild(item, 'Position')?.textContent ?? 0),
    alignment: (
      { LeftAlign: 'left', CenterAlign: 'center', RightAlign: 'right', CharacterAlign: 'decimal' } as const
    )[(firstChild(item, 'Alignment')?.textContent ?? 'LeftAlign') as 'LeftAlign'],
    leader: firstChild(item, 'Leader')?.textContent ?? undefined,
    alignOn: firstChild(item, 'AlignmentCharacter')?.textContent ?? undefined,
  }));
}

// ---- hyperlinks -----------------------------------------------------------------------------------

export interface HyperlinkInfo {
  id: string;
  name: string;
  url: string;
  text: string;
}

/**
 * The designmap has a fixed element order, so a new child goes after the last element that may
 * precede it — not simply at the end, which puts it after the ones that must follow.
 */
const DESIGNMAP_ORDER = [
  'Language',
  'idPkg:Graphic',
  'idPkg:Fonts',
  'KinsokuTable',
  'MojikumiTable',
  'idPkg:Styles',
  'NumberingList',
  'NamedGrid',
  'MotionPreset',
  'Condition',
  'ConditionSet',
  'idPkg:Preferences',
  'LinkedStoryOption',
  'TaggedPDFPreference',
  'MetadataPacketPreference',
  'WatermarkPreference',
  'ConditionalTextPreference',
  'TextVariable',
  'idPkg:Tags',
  'Layer',
  'idPkg:MasterSpread',
  'idPkg:Spread',
  'Section',
  'DocumentUser',
  'CrossReferenceFormat',
  'Index',
  'idPkg:BackingStory',
  'idPkg:Story',
  'HyperlinkPageDestination',
  'HyperlinkURLDestination',
  'HyperlinkExternalPageDestination',
  'HyperlinkPageItemSource',
  'Hyperlink',
  'idPkg:Mapping',
  'Bookmark',
  'PreflightProfile',
];

/** Puts `el` into the designmap where the schema expects an element of that name. */
function insertIntoDesignmap(doc: IdmlDocument, el: Element, tagName: string): void {
  const kids = children(doc.root);
  const index = DESIGNMAP_ORDER.indexOf(tagName);
  if (index < 0) {
    insertAfter(doc.root, el, kids.at(-1));
    return;
  }
  const before = new Set(DESIGNMAP_ORDER.slice(0, index + 1));
  const previous = kids.filter((c) => before.has(c.tagName)).at(-1);
  if (previous) {
    insertAfter(doc.root, el, previous);
    return;
  }
  // Nothing that may precede it yet: go in front of the first thing that has to follow.
  const after = new Set(DESIGNMAP_ORDER.slice(index + 1));
  const next = kids.find((c) => after.has(c.tagName));
  if (next) doc.root.insertBefore(el, next);
  else insertAfter(doc.root, el, kids.at(-1));
}

/**
 * Makes a piece of text (or every occurrence of it) a hyperlink to a URL. The text keeps its
 * formatting; InDesign shows it in the Hyperlinks panel and exports it to PDF/EPUB.
 */
export function createHyperlink(
  doc: IdmlDocument,
  story: Element,
  find: string,
  url: string,
  options: { characterStyle?: string; name?: string; all?: boolean } = {},
): HyperlinkInfo[] {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('#')) url = `https://${url}`;
  const made: HyperlinkInfo[] = [];
  const charStyle = options.characterStyle
    ? styleSelf(doc, 'CharacterStyle', options.characterStyle)
    : undefined;
  // Each link splits a Content node into up to three, so the tree is re-scanned every round.
  for (let round = 0; round < 500; round++) {
    const content = (Array.from(story.getElementsByTagName('Content')) as Element[]).find(
      (c) => (c.textContent ?? '').includes(find) && !isInsideHyperlink(c),
    );
    if (!content) break;
    const text = content.textContent ?? '';
    const idx = text.indexOf(find);
    const before = text.slice(0, idx);
    const after = text.slice(idx + find.length);
    const xml = ownerDoc(content);
    const sourceId = doc.newId();
    const linked = fragment(
      xml,
      `<HyperlinkTextSource Self="${sourceId}" Name="${escapeAttr(options.name ?? find)}" Hidden="false" AppliedCharacterStyle="${escapeAttr(charStyle ?? NO_CHARACTER_STYLE)}"><Content/></HyperlinkTextSource>`,
    );
    firstChild(linked, 'Content')!.appendChild(xml.createTextNode(find));
    const parent = content.parentNode!;
    if (before) {
      const b = xml.createElement('Content');
      b.appendChild(xml.createTextNode(before));
      parent.insertBefore(b, content);
    }
    parent.insertBefore(linked, content);
    if (after) {
      const a = xml.createElement('Content');
      a.appendChild(xml.createTextNode(after));
      parent.insertBefore(a, content);
    }
    parent.removeChild(content);

    const destId = doc.newId();
    const linkId = doc.newId();
    const key = String(1000 + made.length + Math.floor(Math.random() * 100000));
    const dest = fragment(
      doc.designmap,
      `<HyperlinkURLDestination Self="${destId}" Name="${escapeAttr(url)}" DestinationURL="${escapeAttr(url)}" DestinationUniqueKey="${key}" Hidden="false"/>`,
    );
    insertIntoDesignmap(doc, dest, 'HyperlinkURLDestination');
    const link = fragment(
      doc.designmap,
      `<Hyperlink Self="${linkId}" Name="${escapeAttr(options.name ?? find)}" Source="${sourceId}" Visible="false" Highlight="None" Width="Thin" BorderStyle="Solid" Hidden="false" DestinationUniqueKey="${key}"><Properties><BorderColor type="enumeration">Black</BorderColor><Destination type="object">${destId}</Destination></Properties></Hyperlink>`,
    );
    insertIntoDesignmap(doc, link, 'Hyperlink');
    made.push({ id: linkId, name: options.name ?? find, url, text: find });
    if (!options.all) break;
  }
  if (!made.length) throw new Error(`The text "${find}" was not found in that text frame`);
  return made;
}

/** True when the node already sits inside a hyperlink source (so it is not linked twice). */
function isInsideHyperlink(node: Element): boolean {
  let p = node.parentNode as Element | null;
  while (p) {
    if (p.tagName === 'HyperlinkTextSource') return true;
    p = p.parentNode as Element | null;
  }
  return false;
}

export function listHyperlinks(doc: IdmlDocument): HyperlinkInfo[] {
  const destinations = new Map<string, string>();
  for (const d of children(doc.root, 'HyperlinkURLDestination'))
    destinations.set(attr(d, 'Self') ?? '', attr(d, 'DestinationURL') ?? '');
  return children(doc.root, 'Hyperlink').map((h) => {
    const destProp = firstChild(propertiesOf(h) ?? h, 'Destination');
    const destId = destProp?.textContent?.trim() ?? '';
    return {
      id: attr(h, 'Self') ?? '',
      name: attr(h, 'Name') ?? '',
      url: destinations.get(destId) ?? '',
      text: attr(h, 'Name') ?? '',
    };
  });
}

// ---- sections and page numbering --------------------------------------------------------------------

export interface SectionSpec {
  /** Page where the section starts (1-based). */
  startPage?: number;
  pageNumberStart?: number;
  continueNumbering?: boolean;
  style?: 'arabic' | 'upper-roman' | 'lower-roman' | 'upper-letters' | 'lower-letters';
  prefix?: string;
  marker?: string;
  includePrefix?: boolean;
}

const PAGE_NUMBER_STYLE: Record<string, string> = {
  arabic: 'Arabic',
  'upper-roman': 'UpperRoman',
  'lower-roman': 'LowerRoman',
  'upper-letters': 'UpperLetters',
  'lower-letters': 'LowerLetters',
};

/** Creates or updates the section that starts at `startPage`, which controls page numbering. */
export function setSection(doc: IdmlDocument, spec: SectionSpec): { name: string; startPage: number } {
  const pages = listPages(doc);
  const startPage = Math.max(1, Math.min(pages.length, Math.floor(spec.startPage ?? 1)));
  const pageId = pages[startPage - 1]!.id;
  let section = children(doc.root, 'Section').find((s) => attr(s, 'PageStart') === pageId);
  if (!section) {
    section = fragment(
      doc.designmap,
      `<Section Self="${doc.newId()}" Length="1" Name="" ContinueNumbering="false" IncludeSectionPrefix="false" Marker="" PageStart="${pageId}" SectionPrefix=""><Properties><PageNumberStyle type="enumeration">Arabic</PageNumberStyle></Properties></Section>`,
    );
    const existing = children(doc.root, 'Section');
    insertIntoDesignmap(doc, section, 'Section');
  }
  if (spec.pageNumberStart !== undefined) {
    section.setAttribute('PageNumberStart', String(Math.max(1, Math.floor(spec.pageNumberStart))));
    section.setAttribute('ContinueNumbering', 'false');
  }
  if (spec.continueNumbering !== undefined)
    section.setAttribute('ContinueNumbering', spec.continueNumbering ? 'true' : 'false');
  if (spec.prefix !== undefined) section.setAttribute('SectionPrefix', spec.prefix);
  if (spec.marker !== undefined) section.setAttribute('Marker', spec.marker);
  if (spec.includePrefix !== undefined)
    section.setAttribute('IncludeSectionPrefix', spec.includePrefix ? 'true' : 'false');
  if (spec.style)
    setProperty(section, 'PageNumberStyle', 'enumeration', PAGE_NUMBER_STYLE[spec.style] ?? 'Arabic');
  // recompute lengths so the sections cover the document
  const sections = children(doc.root, 'Section');
  const starts = sections
    .map((s) => pages.findIndex((p) => p.id === attr(s, 'PageStart')))
    .map((i) => (i < 0 ? 0 : i))
    .sort((a, b) => a - b);
  sections
    .slice()
    .sort(
      (a, b) =>
        pages.findIndex((p) => p.id === attr(a, 'PageStart')) -
        pages.findIndex((p) => p.id === attr(b, 'PageStart')),
    )
    .forEach((s, i) => {
      const from = starts[i] ?? 0;
      const to = starts[i + 1] ?? pages.length;
      s.setAttribute('Length', String(Math.max(1, to - from)));
    });
  renumberPages(doc);
  return { name: attr(section, 'Name') ?? '', startPage };
}

/** Recomputes the page names (what InDesign shows in the Pages panel) from the sections. */
export function renumberPages(doc: IdmlDocument): void {
  const pages = listPages(doc);
  const sections = children(doc.root, 'Section')
    .map((s) => ({
      el: s,
      start: Math.max(
        0,
        pages.findIndex((p) => p.id === attr(s, 'PageStart')),
      ),
      numberStart: attr(s, 'PageNumberStart') ? Number(attr(s, 'PageNumberStart')) : undefined,
      continues: attr(s, 'ContinueNumbering') === 'true',
      style: firstChild(propertiesOf(s) ?? s, 'PageNumberStyle')?.textContent ?? 'Arabic',
      prefix: attr(s, 'IncludeSectionPrefix') === 'true' ? (attr(s, 'SectionPrefix') ?? '') : '',
    }))
    .sort((a, b) => a.start - b.start);
  if (!sections.length) return;
  let counter = 1;
  for (let i = 0; i < pages.length; i++) {
    const section = [...sections].reverse().find((s) => s.start <= i);
    if (section && section.start === i) counter = section.continues ? counter : (section.numberStart ?? 1);
    const el = doc.findBySelf(pages[i]!.id)?.element;
    if (el)
      el.setAttribute(
        'Name',
        `${section?.prefix ?? ''}${formatPageNumber(counter, section?.style ?? 'Arabic')}`,
      );
    counter++;
  }
}

export function formatPageNumber(n: number, style: string): string {
  switch (style) {
    case 'UpperRoman':
      return toRoman(n);
    case 'LowerRoman':
      return toRoman(n).toLowerCase();
    case 'UpperLetters':
      return toLetters(n);
    case 'LowerLetters':
      return toLetters(n).toLowerCase();
    default:
      return String(n);
  }
}

function toRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let out = '';
  let rest = Math.max(1, Math.floor(n));
  for (const [value, sym] of table) {
    while (rest >= value) {
      out += sym;
      rest -= value;
    }
  }
  return out;
}

function toLetters(n: number): string {
  // InDesign repeats the letter: A..Z, AA, BB, CC …
  const i = Math.max(1, Math.floor(n)) - 1;
  const letter = String.fromCharCode(65 + (i % 26));
  return letter.repeat(Math.floor(i / 26) + 1);
}

// ---- anchored objects ------------------------------------------------------------------------------

export type AnchorPosition = 'inline' | 'above-line' | 'custom';

export interface AnchorSpec {
  position?: AnchorPosition;
  /** Vertical offset from the baseline for inline objects. */
  yOffset?: number;
  xOffset?: number;
  spaceAbove?: number;
  alignment?: 'left' | 'center' | 'right';
}

/**
 * Anchors an existing page item into a story so it flows with the text (InDesign's anchored
 * object). The item is moved from the spread into the text at the first occurrence of `find`,
 * or at the end of the story.
 */
export function anchorItem(
  _doc: IdmlDocument,
  story: Element,
  item: Element,
  options: AnchorSpec & { find?: string } = {},
): Element {
  if (!isPageItem(item)) throw new Error('Only page items can be anchored');
  const bounds = anchorBounds(readPaths(item));
  const xml = ownerDoc(story);
  const imported = xml.importNode(item, true) as Element;
  removeElement(item);
  // an anchored object's geometry is relative to the anchor point
  const paths = readPaths(imported);
  if (paths.length) {
    const { writePaths } = require('./geometry.ts') as typeof import('./geometry.ts');
    writePaths(
      imported,
      paths.map((p) => ({
        open: p.open,
        points: p.points.map((pt) => ({
          anchor: { x: pt.anchor.x - bounds.x, y: pt.anchor.y - bounds.y - bounds.height },
          left: { x: pt.left.x - bounds.x, y: pt.left.y - bounds.y - bounds.height },
          right: { x: pt.right.x - bounds.x, y: pt.right.y - bounds.y - bounds.height },
        })),
      })),
    );
  }
  imported.setAttribute('ItemTransform', '1 0 0 1 0 0');
  const position = options.position ?? 'inline';
  const setting = fragment(
    xml,
    `<AnchoredObjectSetting AnchoredPosition="${position === 'inline' ? 'InlinePosition' : position === 'above-line' ? 'AboveLine' : 'Anchored'}" SpineRelative="false" LockPosition="false" PinPosition="true" AnchorPoint="TopLeftAnchor" HorizontalAlignment="${{ left: 'LeftAlign', center: 'CenterAlign', right: 'RightAlign' }[options.alignment ?? 'left']}" HorizontalReferencePoint="TextFrame" VerticalAlignment="BottomAlign" VerticalReferencePoint="LineBaseline" AnchorXoffset="${options.xOffset ?? 0}" AnchorYoffset="${options.yOffset ?? 0}" AnchorSpaceAbove="${options.spaceAbove ?? 0}"/>`,
  );
  const existing = firstChild(imported, 'AnchoredObjectSetting');
  if (existing) imported.replaceChild(setting, existing);
  else imported.insertBefore(setting, imported.firstChild);

  // place it in the text
  let target: Element | undefined;
  if (options.find) {
    for (const content of Array.from(story.getElementsByTagName('Content')) as Element[]) {
      const text = content.textContent ?? '';
      const idx = text.indexOf(options.find);
      if (idx < 0) continue;
      const parent = content.parentNode as Element;
      const before = text.slice(0, idx);
      const after = text.slice(idx + options.find.length);
      if (before) {
        const b = xml.createElement('Content');
        b.appendChild(xml.createTextNode(before));
        parent.insertBefore(b, content);
      }
      parent.insertBefore(imported, content);
      if (after) {
        const a = xml.createElement('Content');
        a.appendChild(xml.createTextNode(after));
        parent.insertBefore(a, content);
      }
      parent.removeChild(content);
      target = imported;
      break;
    }
    if (!target) throw new Error(`The text "${options.find}" was not found in that story`);
  } else {
    const ranges = Array.from(story.getElementsByTagName('CharacterStyleRange')) as Element[];
    const last = ranges.at(-1);
    if (!last) throw new Error('The story has no text to anchor the item into');
    last.appendChild(imported);
  }
  return imported;
}

// ---- special characters ------------------------------------------------------------------------------

export const SPECIAL_CHARACTERS: Record<string, string> = {
  'em-dash': '—',
  'en-dash': '–',
  bullet: '•',
  ellipsis: '…',
  copyright: '©',
  registered: '®',
  trademark: '™',
  section: '§',
  paragraph: '¶',
  degree: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  'non-breaking-space': ' ',
  'thin-space': ' ',
  'hair-space': ' ',
  'en-space': ' ',
  'em-space': ' ',
  'forced-line-break': ' ',
  'discretionary-hyphen': '­',
  'non-breaking-hyphen': '‑',
  'zero-width-space': '​',
  'right-quote': '’',
  'left-quote': '‘',
  'right-double-quote': '”',
  'left-double-quote': '“',
};

/** Replaces the InDesign-style names in `text` (e.g. <em-dash>) with the real characters. */
export function expandSpecialCharacters(text: string): string {
  return text.replace(/<([a-z-]+)>/g, (whole, name: string) => SPECIAL_CHARACTERS[name] ?? whole);
}

export { findPage, resolveStyle };
