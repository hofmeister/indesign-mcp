// Stories hold the text of text frames: ParagraphStyleRange > CharacterStyleRange > Content | Br.
import type { IdmlDocument } from './document.ts';
import { escapeAttr } from './layers.ts';
import {
  attr,
  children,
  createIdPkgRef,
  type Element,
  fragment,
  insertAfter,
  type Node,
  ownerDoc,
  removeElement,
  setProperty,
} from './xml.ts';

export interface Run {
  text: string;
  /** CharacterStyle Self, e.g. "CharacterStyle/Emphasis". */
  characterStyle?: string;
  /** Local overrides such as FontStyle="Bold", PointSize="14", FillColor="Color/Red". */
  attrs?: Record<string, string>;
  /** Typed properties such as AppliedFont (string) or Leading (unit). */
  props?: Record<string, { type: string; value: string }>;
  /** An anchored page item sitting at this point in the text. */
  anchored?: Element;
  /** A marker InDesign resolves when it lays the text out (the automatic page number). */
  marker?: 'page-number' | 'section-marker';
  /** Name of the text variable this run stands for; its text is the variable's current result. */
  variable?: string;
}

export interface Paragraph {
  /** ParagraphStyle Self, e.g. "ParagraphStyle/Body". */
  style: string;
  runs: Run[];
  attrs?: Record<string, string>;
}

export const NO_PARAGRAPH_STYLE = 'ParagraphStyle/$ID/[No paragraph style]';
export const BASIC_PARAGRAPH_STYLE = 'ParagraphStyle/$ID/NormalParagraphStyle';
export const NO_CHARACTER_STYLE = 'CharacterStyle/$ID/[No character style]';

/** Page items that can be anchored in text. */
const ANCHORED_TAGS = ['Rectangle', 'Oval', 'Polygon', 'GraphicLine', 'TextFrame', 'Group', 'Button'];

/** Reads the paragraphs of a story (or XmlStory). Tables and notes are skipped. */
export function readStory(story: Element): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  // `current` is the paragraph receiving content; null after a <Br/> until the next content arrives.
  let current: Paragraph | null = null;
  const visitPsr = (psr: Element) => {
    const style = attr(psr, 'AppliedParagraphStyle') ?? NO_PARAGRAPH_STYLE;
    const psrAttrs = otherAttrs(psr, ['AppliedParagraphStyle']);
    // A new ParagraphStyleRange always starts a new paragraph.
    current = null;
    let created = 0;
    const ensure = (): Paragraph => {
      if (!current) {
        current = { style, runs: [], attrs: psrAttrs };
        paragraphs.push(current);
        created++;
      }
      return current;
    };
    const visitCsr = (csr: Element) => {
      const characterStyle = attr(csr, 'AppliedCharacterStyle') ?? NO_CHARACTER_STYLE;
      const attrs = otherAttrs(csr, ['AppliedCharacterStyle']);
      const props = readProps(csr);
      const push = (text: string) => {
        const para = ensure();
        const last = para.runs.at(-1);
        if (
          last &&
          !last.anchored &&
          !last.marker &&
          last.characterStyle === characterStyle &&
          sameRecord(last.attrs, attrs) &&
          sameProps(last.props, props)
        ) {
          last.text += text;
        } else {
          para.runs.push({ text, characterStyle, attrs, props });
        }
      };
      // Wrappers that hold text but do not start a new run (hyperlinks, cross references, notes).
      const INLINE_WRAPPERS = [
        'HyperlinkTextSource',
        'HyperlinkTextDestination',
        'CrossReferenceSource',
        'PageReference',
        'ParagraphDestination',
      ];
      const pushMarker = (marker: Run['marker']) => {
        ensure().runs.push({
          text: marker === 'page-number' ? '#' : '',
          characterStyle,
          attrs,
          props,
          marker,
        });
      };
      // <Content> can hold processing instructions: <?ACE 18?> is the automatic page number.
      const walkContent = (content: Element) => {
        for (let n = content.firstChild; n; n = n.nextSibling) {
          if (n.nodeType === 3) push(n.textContent ?? '');
          else if (n.nodeType === 7) {
            const pi = n as unknown as { target?: string; data?: string };
            if (pi.target === 'ACE') {
              const code = (pi.data ?? '').trim();
              if (code === '18') pushMarker('page-number');
              else if (code === '19') pushMarker('section-marker');
            }
          }
        }
      };
      const walkRange = (el: Element) => {
        for (const c of children(el)) {
          if (c.tagName === 'Content') walkContent(c);
          else if (c.tagName === 'Br') {
            ensure();
            current = null;
          } else if (c.tagName === 'TextVariableInstance') {
            ensure().runs.push({
              text: attr(c, 'ResultText') ?? '',
              characterStyle,
              attrs,
              props,
              variable: attr(c, 'Name') ?? '',
            });
          } else if (ANCHORED_TAGS.includes(c.tagName)) {
            ensure().runs.push({ text: '', characterStyle, attrs, props, anchored: c });
          } else if (INLINE_WRAPPERS.includes(c.tagName)) walkRange(c);
          else if (c.tagName === 'XMLElement')
            for (const inner of children(c)) {
              if (inner.tagName === 'CharacterStyleRange') visitCsr(inner);
              else if (inner.tagName === 'Content') walkContent(inner);
            }
        }
      };
      walkRange(csr);
    };
    const walk = (el: Element) => {
      for (const c of children(el)) {
        if (c.tagName === 'CharacterStyleRange') visitCsr(c);
        else if (c.tagName === 'XMLElement') walk(c);
      }
    };
    walk(psr);
    if (!created) ensure(); // an empty ParagraphStyleRange is still a paragraph
  };
  const walkStory = (el: Element) => {
    for (const c of children(el)) {
      if (c.tagName === 'ParagraphStyleRange') visitPsr(c);
      else if (c.tagName === 'XMLElement') walkStory(c);
    }
  };
  walkStory(story);
  return paragraphs;
}

function otherAttrs(el: Element, skip: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i)!;
    if (!skip.includes(a.name)) out[a.name] = a.value;
  }
  return out;
}

function readProps(el: Element): Record<string, { type: string; value: string }> {
  const out: Record<string, { type: string; value: string }> = {};
  const props = children(el, 'Properties')[0];
  if (!props) return out;
  for (const p of children(props))
    out[p.tagName] = { type: attr(p, 'type') ?? 'string', value: p.textContent ?? '' };
  return out;
}

function sameRecord(a?: Record<string, string>, b?: Record<string, string>): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}
function sameProps(
  a?: Record<string, { type: string; value: string }>,
  b?: Record<string, { type: string; value: string }>,
): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

export function readStoryPlainText(story: Element, options: { namedVariables?: boolean } = {}): string {
  // A variable whose result is empty (a running head, say) would otherwise make the frame look
  // empty in a listing; showing <its name> says what is really in there.
  const textOf = (run: Run): string =>
    options.namedVariables && run.variable && !run.text ? `<${run.variable}>` : run.text;
  return readStory(story)
    .map((p) => p.runs.map(textOf).join(''))
    .join('\n');
}

/** Removes all paragraph content from a story, keeping StoryPreference and similar settings. */
function clearStoryContent(story: Element): void {
  for (const c of children(story)) {
    if (c.tagName === 'ParagraphStyleRange' || c.tagName === 'XMLElement') removeElement(c);
  }
}

function buildParagraphs(doc: IdmlDocument, story: Element, paragraphs: Paragraph[]): void {
  const xml = ownerDoc(story);
  paragraphs.forEach((para, pi) => {
    const psr = xml.createElement('ParagraphStyleRange');
    psr.setAttribute('AppliedParagraphStyle', para.style || BASIC_PARAGRAPH_STYLE);
    for (const [k, v] of Object.entries(para.attrs ?? {})) psr.setAttribute(k, v);
    const runs = para.runs.length ? para.runs : [{ text: '' }];
    runs.forEach((run, ri) => {
      const csr = xml.createElement('CharacterStyleRange');
      csr.setAttribute('AppliedCharacterStyle', run.characterStyle ?? NO_CHARACTER_STYLE);
      for (const [k, v] of Object.entries(run.attrs ?? {})) csr.setAttribute(k, v);
      for (const [k, v] of Object.entries(run.props ?? {})) setProperty(csr, k, v.type, v.value);
      // Split on U+2028 (forced line break stays inside a paragraph as its own Content? No: it is a character).
      if (run.text.length) {
        const content = xml.createElement('Content');
        content.appendChild(xml.createTextNode(run.text));
        csr.appendChild(content);
      }
      if (ri === runs.length - 1 && pi < paragraphs.length - 1) csr.appendChild(xml.createElement('Br'));
      psr.appendChild(csr);
    });
    insertAfter(story, psr);
  });
  void doc;
}

export interface SetTextOptions {
  paragraphStyle?: string;
  /** Interpret **bold** and *italic* markup. Default true. */
  markup?: boolean;
}

/** Replaces the whole text of a story. `text` may be a string (paragraphs separated by \n) or Paragraph[]. */
export function setStoryText(
  doc: IdmlDocument,
  story: Element,
  text: string | Paragraph[],
  options: SetTextOptions = {},
): void {
  clearStoryContent(story);
  const paragraphs = typeof text === 'string' ? textToParagraphs(text, options) : text;
  buildParagraphs(doc, story, paragraphs);
}

export function appendStoryText(
  doc: IdmlDocument,
  story: Element,
  text: string | Paragraph[],
  options: SetTextOptions = {},
): void {
  const existing = readStory(story);
  const added = typeof text === 'string' ? textToParagraphs(text, options) : text;
  const isEmpty = existing.length === 0 || (existing.length === 1 && existing[0]!.runs.every((r) => !r.text));
  clearStoryContent(story);
  buildParagraphs(doc, story, isEmpty ? added : [...existing, ...added]);
}

export function textToParagraphs(text: string, options: SetTextOptions = {}): Paragraph[] {
  const style = options.paragraphStyle ?? BASIC_PARAGRAPH_STYLE;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines.map((line) => ({
    style,
    runs: options.markup === false ? [{ text: line }] : parseInlineMarkup(line),
  }));
}

/** Very small markdown subset: **bold**, *italic*, ***bold italic***. */
export function parseInlineMarkup(line: string): Run[] {
  const runs: Run[] = [];
  const re = /(\*\*\*([^*]+)\*\*\*)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) runs.push({ text: line.slice(last, idx) });
    if (m[2]) runs.push({ text: m[2], attrs: { FontStyle: 'Bold Italic' } });
    else if (m[4]) runs.push({ text: m[4], attrs: { FontStyle: 'Bold' } });
    else if (m[6]) runs.push({ text: m[6], attrs: { FontStyle: 'Italic' } });
    last = idx + m[0].length;
  }
  if (last < line.length || !runs.length) runs.push({ text: line.slice(last) });
  return runs;
}

/** Creates a new story part and registers it in designmap. Returns the <Story> element. */
export function createStory(
  doc: IdmlDocument,
  options: { text: string | Paragraph[]; paragraphStyle?: string },
): Element {
  const id = doc.newId();
  const part = `Stories/Story_${id}.xml`;
  const partDoc = doc.newPartDocument('Story');
  const story = fragment(
    partDoc,
    `<Story Self="${id}" UserText="true" IsEndnoteStory="false" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n"><StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12" FrameType="TextFrameType" StoryOrientation="Horizontal" StoryDirection="LeftToRightDirection"/><InCopyExportOption IncludeGraphicProxies="true" IncludeAllResources="false"/></Story>`,
  );
  const root = partDoc.documentElement!;
  root.appendChild(partDoc.createTextNode('\n\t'));
  root.appendChild(story);
  root.appendChild(partDoc.createTextNode('\n'));
  doc.addXmlPart(part, partDoc);
  // designmap: idPkg:Story reference after the last story (or after BackingStory)
  const ref = createIdPkgRef(doc.designmap, 'Story', part);
  const all = children(doc.root);
  const anchor =
    all.filter((c) => c.tagName === 'idPkg:Story').at(-1) ??
    all.find((c) => c.tagName === 'idPkg:BackingStory') ??
    all.filter((c) => c.tagName.startsWith('idPkg:')).at(-1);
  insertAfter(doc.root, ref, anchor);
  const list = (attr(doc.root, 'StoryList') ?? '').split(/\s+/).filter(Boolean);
  list.push(id);
  doc.root.setAttribute('StoryList', list.join(' '));
  setStoryText(doc, story, options.text, { paragraphStyle: options.paragraphStyle });
  return story;
}

// ---- in-place edits ------------------------------------------------------------------------

export interface FindReplaceOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

function buildRegex(find: string, o: FindReplaceOptions): RegExp {
  let source = o.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) source = `\\b${source}\\b`;
  return new RegExp(source, o.caseSensitive ? 'g' : 'gi');
}

/** Replaces text inside Content nodes. Matches spanning several runs are not replaced. Returns count. */
export function replaceInStory(
  story: Element,
  find: string,
  replace: string,
  o: FindReplaceOptions = {},
): number {
  const re = buildRegex(find, o);
  let count = 0;
  for (const content of Array.from(story.getElementsByTagName('Content'))) {
    const text = content.textContent ?? '';
    const matches = text.match(re);
    if (!matches) continue;
    count += matches.length;
    const replaced = text.replace(re, replace);
    while (content.firstChild) content.removeChild(content.firstChild);
    content.appendChild(ownerDoc(content).createTextNode(replaced));
  }
  return count;
}

export function findInStory(story: Element, find: string, o: FindReplaceOptions = {}): number {
  const re = buildRegex(find, o);
  return (readStoryPlainText(story).match(re) ?? []).length;
}

export interface ParagraphSelector {
  /** 1-based paragraph numbers. */
  paragraphs?: number[];
  /** Paragraphs containing this text (case-insensitive). */
  containing?: string;
  /** Apply to every paragraph (default when no other selector is given). */
  all?: boolean;
}

export function applyParagraphStyle(story: Element, styleSelf: string, sel: ParagraphSelector = {}): number {
  const psrs = collectParagraphRanges(story);
  let n = 0;
  psrs.forEach((psr, i) => {
    const text = psr.text.toLowerCase();
    const match =
      (sel.paragraphs?.includes(i + 1) ?? false) ||
      (sel.containing !== undefined && text.includes(sel.containing.toLowerCase())) ||
      (!sel.paragraphs && sel.containing === undefined);
    if (!match) return;
    psr.element.setAttribute('AppliedParagraphStyle', styleSelf);
    n++;
  });
  return n;
}

/**
 * Paragraph ranges as (element, text) pairs. A ParagraphStyleRange that contains several paragraphs
 * (separated by Br) counts once; changing its style changes all of them, like selecting them in InDesign.
 */
function collectParagraphRanges(story: Element): { element: Element; text: string }[] {
  const out: { element: Element; text: string }[] = [];
  const walk = (el: Element) => {
    for (const c of children(el)) {
      if (c.tagName === 'ParagraphStyleRange')
        out.push({
          element: c,
          text: Array.from(c.getElementsByTagName('Content'))
            .map((x) => x.textContent ?? '')
            .join(''),
        });
      else if (c.tagName === 'XMLElement') walk(c);
    }
  };
  walk(story);
  return out;
}

export interface RunFormatting {
  characterStyle?: string;
  attrs?: Record<string, string | null>;
  props?: Record<string, { type: string; value: string } | null>;
}

/**
 * Applies formatting to every occurrence of `find` (within single Content nodes) by splitting the
 * CharacterStyleRange around the match. Returns the number of occurrences formatted.
 */
export function formatMatches(
  story: Element,
  find: string,
  fmt: RunFormatting,
  o: FindReplaceOptions = {},
): number {
  const re = buildRegex(find, o);
  let count = 0;
  for (const csr of Array.from(story.getElementsByTagName('CharacterStyleRange'))) {
    const contents = children(csr, 'Content');
    for (const content of contents) {
      const text = content.textContent ?? '';
      const parts: { text: string; hit: boolean }[] = [];
      let last = 0;
      for (const m of text.matchAll(re)) {
        const idx = m.index ?? 0;
        if (!m[0]) continue;
        if (idx > last) parts.push({ text: text.slice(last, idx), hit: false });
        parts.push({ text: m[0], hit: true });
        last = idx + m[0].length;
      }
      if (!parts.some((p) => p.hit)) continue;
      if (last < text.length) parts.push({ text: text.slice(last), hit: false });
      count += parts.filter((p) => p.hit).length;
      splitRange(csr, content, parts, fmt);
    }
  }
  return count;
}

/** Splits `csr` at `content` into several ranges: [before-content..., pieces..., after-content...]. */
function splitRange(
  csr: Element,
  content: Element,
  parts: { text: string; hit: boolean }[],
  fmt: RunFormatting,
): void {
  const xml = ownerDoc(csr);
  const parent = csr.parentNode as Element;
  const kids = Array.from(csr.childNodes).filter((n) => n.nodeType === 1) as Element[];
  const idx = kids.indexOf(content);
  const before = kids.slice(0, idx);
  const after = kids.slice(idx + 1);
  const makeRange = (nodes: Node[], apply: boolean): Element => {
    const r = csr.cloneNode(false) as Element;
    const props = children(csr, 'Properties')[0];
    if (props) r.appendChild(props.cloneNode(true));
    for (const n of nodes) r.appendChild(n);
    if (apply) {
      if (fmt.characterStyle) r.setAttribute('AppliedCharacterStyle', fmt.characterStyle);
      for (const [k, v] of Object.entries(fmt.attrs ?? {}))
        v === null ? r.removeAttribute(k) : r.setAttribute(k, v);
      for (const [k, v] of Object.entries(fmt.props ?? {}))
        setProperty(r, k, v?.type ?? 'string', v ? v.value : null);
    }
    return r;
  };
  const ranges: Element[] = [];
  if (before.filter((k) => k.tagName !== 'Properties').length)
    ranges.push(
      makeRange(
        before.filter((k) => k.tagName !== 'Properties'),
        false,
      ),
    );
  for (const p of parts) {
    const c = xml.createElement('Content');
    c.appendChild(xml.createTextNode(p.text));
    ranges.push(makeRange([c], p.hit));
  }
  if (after.length) ranges.push(makeRange(after, false));
  let ref: Element = csr;
  for (const r of ranges) {
    parent.insertBefore(r, ref.nextSibling);
    ref = r;
  }
  parent.removeChild(csr);
}

/** Inserts an auto page number marker (the <?ACE 18?> processing instruction) as a new paragraph run. */
export function appendPageNumberMarker(
  story: Element,
  options: { prefix?: string; suffix?: string; paragraphStyle?: string; find?: string } = {},
): void {
  const xml = ownerDoc(story);
  if (options.find) {
    replaceTextWithPageNumberMarker(story, options.find, options);
    return;
  }
  const psrs = children(story, 'ParagraphStyleRange');
  let psr = psrs.at(-1);
  if (!psr) {
    psr = xml.createElement('ParagraphStyleRange');
    psr.setAttribute('AppliedParagraphStyle', options.paragraphStyle ?? BASIC_PARAGRAPH_STYLE);
    insertAfter(story, psr);
  } else if (options.paragraphStyle) {
    psr.setAttribute('AppliedParagraphStyle', options.paragraphStyle);
  }
  // Match the formatting of the text already in the paragraph. Starting from a bare
  // CharacterStyleRange would fall back to [Basic Paragraph] — a serif page number next to a sans
  // footer, and a font the document never asked for dragged into its font list.
  const previous = children(psr, 'CharacterStyleRange').at(-1);
  const csr = previous ? (previous.cloneNode(true) as Element) : xml.createElement('CharacterStyleRange');
  // Keep <Properties> (AppliedFont and friends); drop only the text it used to hold.
  if (previous)
    for (const c of children(csr))
      if (c.tagName === 'Content' || c.tagName === 'Br') removeElement(c);
      else csr.setAttribute('AppliedCharacterStyle', NO_CHARACTER_STYLE);
  const content = xml.createElement('Content');
  if (options.prefix) content.appendChild(xml.createTextNode(options.prefix));
  content.appendChild(xml.createProcessingInstruction('ACE', '18'));
  if (options.suffix) content.appendChild(xml.createTextNode(options.suffix));
  csr.appendChild(content);
  psr.appendChild(csr);
}

/** Puts the marker (with its prefix and suffix) where `find` sits in the story's text. */
function replaceTextWithPageNumberMarker(
  story: Element,
  find: string,
  options: { prefix?: string; suffix?: string },
): void {
  const xml = ownerDoc(story);
  for (const content of Array.from(story.getElementsByTagName('Content')) as Element[]) {
    for (let node = content.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== 3) continue;
      const text = node.nodeValue ?? '';
      const at = text.indexOf(find);
      if (at < 0) continue;
      const after = text.slice(at + find.length);
      node.nodeValue = text.slice(0, at) + (options.prefix ?? '');
      const marker = xml.createProcessingInstruction('ACE', '18');
      content.insertBefore(marker, node.nextSibling);
      const tail = (options.suffix ?? '') + after;
      if (tail) content.insertBefore(xml.createTextNode(tail), marker.nextSibling);
      return;
    }
  }
  throw new Error(`"${find}" was not found in that text`);
}

export function storyHasPageNumberMarker(story: Element): boolean {
  for (const c of Array.from(story.getElementsByTagName('Content'))) {
    for (let n = c.firstChild; n; n = n.nextSibling)
      if (n.nodeType === 7 && (n as { target?: string }).target === 'ACE') return true;
  }
  return false;
}

export { escapeAttr };
