// Text variables (running headers, dates, file name, chapter number) and the character styling
// InDesign applies automatically inside a paragraph: nested styles, line styles and GREP styles.
import { basename } from 'node:path';
import type { IdmlDocument } from './document.ts';
import { escapeAttr } from './layers.ts';
import { BASIC_PARAGRAPH_STYLE, NO_CHARACTER_STYLE } from './stories.ts';
import { styleSelf } from './styles.ts';
import {
  attr,
  children,
  type Element,
  firstChild,
  fragment,
  type Node,
  ownerDoc,
  propertiesOf,
  removeElement,
} from './xml.ts';

export type VariableKind =
  | 'custom-text'
  | 'file-name'
  | 'last-page-number'
  | 'chapter-number'
  | 'creation-date'
  | 'modification-date'
  | 'output-date'
  | 'running-header-paragraph'
  | 'running-header-character';

const VARIABLE_TYPE: Record<VariableKind, string> = {
  'custom-text': 'CustomTextType',
  'file-name': 'FileNameType',
  'last-page-number': 'LastPageNumberType',
  'chapter-number': 'ChapterNumberType',
  'creation-date': 'CreationDateType',
  'modification-date': 'ModificationDateType',
  'output-date': 'OutputDateType',
  'running-header-paragraph': 'MatchParagraphStyleType',
  'running-header-character': 'MatchCharacterStyleType',
};

export interface VariableSpec {
  name: string;
  kind: VariableKind;
  /** Text of a custom text variable. */
  text?: string;
  /** Date pattern for the date variables, e.g. "d MMMM yyyy". */
  format?: string;
  /** Style a running header follows, e.g. "Heading 1". */
  style?: string;
  /** Take the first or the last match on the page (running headers). */
  use?: 'first' | 'last';
  textBefore?: string;
  textAfter?: string;
  includePath?: boolean;
  includeExtension?: boolean;
}

export interface VariableInfo {
  self: string;
  name: string;
  kind: VariableKind | 'other';
  type: string;
  detail: string | undefined;
}

function variableElements(doc: IdmlDocument): Element[] {
  // Variables whose name carries an <?AID?> marker are InDesign's cross-reference internals,
  // which the user never sees in the Text Variables dialog either.
  return children(doc.root, 'TextVariable').filter((el) => !(attr(el, 'Name') ?? '').startsWith('<?AID'));
}

export function listTextVariables(doc: IdmlDocument): VariableInfo[] {
  return variableElements(doc).map((el) => {
    const type = attr(el, 'VariableType') ?? '';
    const kind = (Object.keys(VARIABLE_TYPE) as VariableKind[]).find((k) => VARIABLE_TYPE[k] === type);
    const custom = firstChild(el, 'CustomTextVariablePreference');
    const match =
      firstChild(el, 'MatchParagraphStylePreference') ?? firstChild(el, 'MatchCharacterStylePreference');
    const date = firstChild(el, 'DateVariablePreference');
    return {
      self: attr(el, 'Self') ?? '',
      name: attr(el, 'Name') ?? '',
      kind: kind ?? 'other',
      type,
      detail: custom
        ? (firstChild(firstChild(custom, 'Properties'), 'Contents')?.textContent ?? '')
        : match
          ? (attr(match, 'AppliedParagraphStyle') ?? attr(match, 'AppliedCharacterStyle'))
          : date
            ? attr(date, 'Format')
            : undefined,
    };
  });
}

export function findTextVariable(doc: IdmlDocument, name: string): Element {
  const el = variableElements(doc).find(
    (v) => attr(v, 'Name')?.toLowerCase() === name.toLowerCase() || attr(v, 'Self') === name,
  );
  if (!el)
    throw new Error(
      `No text variable called "${name}". Existing: ${
        listTextVariables(doc)
          .map((v) => v.name)
          .join(', ') || 'none'
      }`,
    );
  return el;
}

/** Creates (or replaces) a text variable in the document. */
export function createTextVariable(doc: IdmlDocument, spec: VariableSpec): Element {
  const existing = variableElements(doc).find(
    (v) => attr(v, 'Name')?.toLowerCase() === spec.name.toLowerCase(),
  );
  if (existing) removeElement(existing);
  const type = VARIABLE_TYPE[spec.kind];
  const before = spec.textBefore ? ` TextBefore="${escapeAttr(spec.textBefore)}"` : '';
  const after = spec.textAfter ? ` TextAfter="${escapeAttr(spec.textAfter)}"` : '';
  let preference = '';
  switch (spec.kind) {
    case 'custom-text':
      preference = `<CustomTextVariablePreference><Properties><Contents type="string">${escapeAttr(spec.text ?? '')}</Contents></Properties></CustomTextVariablePreference>`;
      break;
    case 'file-name':
      preference = `<FileNameVariablePreference${before}${after} IncludePath="${spec.includePath ? 'true' : 'false'}" IncludeExtension="${spec.includeExtension === false ? 'false' : 'true'}"/>`;
      break;
    case 'last-page-number':
      preference = `<PageNumberVariablePreference${before}${after} Format="Arabic" Scope="DocumentScope"/>`;
      break;
    case 'chapter-number':
      preference = `<ChapterNumberVariablePreference${before}${after} Format="Arabic"/>`;
      break;
    case 'creation-date':
    case 'modification-date':
    case 'output-date':
      preference = `<DateVariablePreference${before}${after} Format="${escapeAttr(spec.format ?? 'dd/MM/yyyy')}"/>`;
      break;
    case 'running-header-paragraph':
      preference = `<MatchParagraphStylePreference${before}${after} AppliedParagraphStyle="${escapeAttr(styleSelf(doc, 'ParagraphStyle', spec.style ?? 'Body'))}" SearchStrategy="${spec.use === 'last' ? 'LastOnPage' : 'FirstOnPage'}" ChangeCase="None" DeleteEndPunctuation="false"/>`;
      break;
    case 'running-header-character':
      preference = `<MatchCharacterStylePreference${before}${after} AppliedCharacterStyle="${escapeAttr(styleSelf(doc, 'CharacterStyle', spec.style ?? 'Emphasis'))}" SearchStrategy="${spec.use === 'last' ? 'LastOnPage' : 'FirstOnPage'}" ChangeCase="None" DeleteEndPunctuation="false"/>`;
      break;
  }
  const el = fragment(
    doc.designmap,
    // InDesign derives the id of a named object from its name, as with styles and swatches.
    `<TextVariable Self="dTextVariablen${escapeAttr(spec.name)}" Name="${escapeAttr(spec.name)}" VariableType="${type}">${preference}</TextVariable>`,
  );
  // TextVariables come after the preferences and before idPkg:Tags in designmap order.
  const tags = children(doc.root).find((c) => c.tagName === 'idPkg:Tags');
  const layer = children(doc.root).find((c) => c.tagName === 'Layer');
  const anchor = tags ?? layer;
  if (anchor) doc.root.insertBefore(el, anchor);
  else doc.root.appendChild(el);
  return el;
}

export function deleteTextVariable(doc: IdmlDocument, name: string): void {
  removeElement(findTextVariable(doc, name));
}

/** What the variable will read once InDesign resolves it (a preview for our own renderer). */
export function resultTextFor(doc: IdmlDocument, variable: Element): string {
  const type = attr(variable, 'VariableType');
  switch (type) {
    case 'CustomTextType':
      return (
        firstChild(firstChild(firstChild(variable, 'CustomTextVariablePreference'), 'Properties'), 'Contents')
          ?.textContent ?? ''
      );
    case 'FileNameType': {
      const pref = firstChild(variable, 'FileNameVariablePreference');
      const path = doc.path ?? 'untitled.idml';
      const name = attr(pref, 'IncludePath') === 'true' ? path : basename(path);
      return attr(pref, 'IncludeExtension') === 'false' ? name.replace(/\.idml$/i, '') : name;
    }
    case 'CreationDateType':
    case 'ModificationDateType':
    case 'OutputDateType': {
      const format = attr(firstChild(variable, 'DateVariablePreference'), 'Format') ?? 'dd/MM/yyyy';
      return formatDate(new Date(), format);
    }
    default:
      return '';
  }
}

/** A small subset of InDesign's date patterns: d, dd, M, MM, MMM, MMMM, yy, yyyy, HH, mm. */
export function formatDate(date: Date, pattern: string): string {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|mm/g, (token) => {
    switch (token) {
      case 'yyyy':
        return String(date.getFullYear());
      case 'yy':
        return String(date.getFullYear()).slice(-2);
      case 'MMMM':
        return months[date.getMonth()]!;
      case 'MMM':
        return months[date.getMonth()]!.slice(0, 3);
      case 'MM':
        return pad(date.getMonth() + 1);
      case 'M':
        return String(date.getMonth() + 1);
      case 'dd':
        return pad(date.getDate());
      case 'd':
        return String(date.getDate());
      case 'HH':
        return pad(date.getHours());
      case 'mm':
        return pad(date.getMinutes());
      default:
        return token;
    }
  });
}

export interface InsertVariableOptions {
  /** Replace this text with the variable; otherwise it is appended to the story. */
  find?: string;
  characterStyle?: string;
  paragraphStyle?: string;
}

/** Puts a variable into a story, either in place of some text or at the end. */
/** The text node inside a story's <Content> that holds `find`, and where in it the match starts. */
function findInStory(story: Element, find: string): { content: Element; node: Node; at: number } | undefined {
  for (const content of Array.from(story.getElementsByTagName('Content')) as Element[]) {
    for (let node = content.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== 3) continue;
      const at = (node.nodeValue ?? '').indexOf(find);
      if (at >= 0) return { content, node, at };
    }
  }
  return undefined;
}

export function insertTextVariable(
  doc: IdmlDocument,
  story: Element,
  name: string,
  options: InsertVariableOptions = {},
): Element {
  const variable = findTextVariable(doc, name);
  const xml = ownerDoc(story);
  const instance = fragment(
    xml,
    `<TextVariableInstance Self="${doc.newId()}" Name="${escapeAttr(attr(variable, 'Name') ?? name)}" ResultText="${escapeAttr(resultTextFor(doc, variable))}" AssociatedTextVariable="${escapeAttr(attr(variable, 'Self') ?? '')}"/>`,
  );
  if (options.find) {
    // Split the text around the match without touching the rest of the <Content>: it can hold an
    // automatic page-number marker, and rebuilding the element from its text alone would drop it.
    const found = findInStory(story, options.find);
    if (!found) throw new Error(`"${options.find}" was not found in that text`);
    const { content, node, at } = found;
    const text = node.nodeValue ?? '';
    const csr = content.parentNode as Element;
    const tail = xml.createElement('Content');
    const after = text.slice(at + options.find.length);
    // Everything after the match — the rest of this text node and every later child — moves to a
    // second <Content> on the far side of the variable.
    while (node.nextSibling) tail.appendChild(node.nextSibling);
    if (after) tail.insertBefore(xml.createTextNode(after), tail.firstChild);
    node.nodeValue = text.slice(0, at);
    if (!node.nodeValue && !content.firstChild?.nextSibling) content.removeChild(node);
    csr.insertBefore(instance, content.nextSibling);
    if (tail.firstChild) csr.insertBefore(tail, instance.nextSibling);
    if (!content.firstChild) csr.removeChild(content);
    return instance;
  }
  let psr = children(story, 'ParagraphStyleRange').at(-1);
  if (!psr) {
    psr = xml.createElement('ParagraphStyleRange');
    psr.setAttribute('AppliedParagraphStyle', options.paragraphStyle ?? BASIC_PARAGRAPH_STYLE);
    story.appendChild(psr);
  }
  let csr = children(psr, 'CharacterStyleRange').at(-1);
  if (!csr || options.characterStyle) {
    csr = xml.createElement('CharacterStyleRange');
    csr.setAttribute(
      'AppliedCharacterStyle',
      options.characterStyle ? styleSelf(doc, 'CharacterStyle', options.characterStyle) : NO_CHARACTER_STYLE,
    );
    psr.appendChild(csr);
  }
  csr.appendChild(instance);
  return instance;
}

// ---- nested, line and GREP styles ------------------------------------------------------------

export interface NestedStyleSpec {
  characterStyle: string;
  /** Where the nested style stops: a literal string, or one of the InDesign delimiters. */
  through:
    | string
    | 'Sentence'
    | 'AnyWord'
    | 'AnyCharacter'
    | 'Letters'
    | 'Digits'
    | 'Tabs'
    | 'ForcedLineBreak'
    | 'EndNestedStyle'
    | 'EmSpace'
    | 'EnSpace'
    | 'NonbreakingSpace';
  /** How many of them (default 1). */
  repetition?: number;
  /** Include the delimiter itself in the styled run (default true). */
  inclusive?: boolean;
}

const DELIMITER_KEYWORDS = new Set([
  'Sentence',
  'AnyWord',
  'AnyCharacter',
  'Letters',
  'Digits',
  'Tabs',
  'InlineGraphic',
  'Dropcap',
  'ForcedLineBreak',
  'EndNestedStyle',
  'IndentHereTab',
  'EmSpace',
  'EnSpace',
  'NonbreakingSpace',
  'AutoPageNumber',
  'SectionMarker',
  'Repeat',
]);

function replaceList(style: Element, name: string, items: string[]): void {
  const props = propertiesOf(style, true);
  const existing = firstChild(props, name);
  if (existing) removeElement(existing);
  if (!items.length) return;
  props.appendChild(fragment(ownerDoc(style), `<${name} type="list">${items.join('')}</${name}>`));
}

/** Styles the beginning of every paragraph: "the first two words in Bold", and so on. */
export function setNestedStyles(doc: IdmlDocument, style: Element, specs: NestedStyleSpec[]): void {
  const items = specs.map((spec) => {
    const delimiter = DELIMITER_KEYWORDS.has(String(spec.through))
      ? `<Delimiter type="enumeration">${spec.through}</Delimiter>`
      : `<Delimiter type="string">${escapeAttr(String(spec.through))}</Delimiter>`;
    return `<ListItem type="record"><AppliedCharacterStyle type="object">${escapeAttr(styleSelf(doc, 'CharacterStyle', spec.characterStyle))}</AppliedCharacterStyle>${delimiter}<Repetition type="long">${Math.max(1, Math.floor(spec.repetition ?? 1))}</Repetition><Inclusive type="boolean">${spec.inclusive === false ? 'false' : 'true'}</Inclusive></ListItem>`;
  });
  replaceList(style, 'AllNestedStyles', items);
  style.setAttribute('EmptyNestedStyles', items.length ? 'false' : 'true');
}

export interface LineStyleSpec {
  characterStyle: string;
  /** How many lines it covers (default 1). */
  lines?: number;
  /** Repeat the pattern after the last line (default false). */
  repeat?: boolean;
}

/** Styles whole lines: "the first line in small caps". */
export function setLineStyles(doc: IdmlDocument, style: Element, specs: LineStyleSpec[]): void {
  const items = specs.map(
    (spec) =>
      `<ListItem type="record"><AppliedCharacterStyle type="object">${escapeAttr(styleSelf(doc, 'CharacterStyle', spec.characterStyle))}</AppliedCharacterStyle><LineCount type="long">${Math.max(1, Math.floor(spec.lines ?? 1))}</LineCount><RepeatLast type="long">${spec.repeat ? 1 : 0}</RepeatLast></ListItem>`,
  );
  replaceList(style, 'AllLineStyles', items);
}

export interface GrepStyleSpec {
  characterStyle: string;
  /** An InDesign GREP pattern, e.g. "\\d+" for numbers or "\\b[A-Z]{2,}\\b" for acronyms. */
  pattern: string;
}

/** Styles every match of a pattern, wherever it appears in the paragraph. */
export function setGrepStyles(doc: IdmlDocument, style: Element, specs: GrepStyleSpec[]): void {
  const items = specs.map(
    (spec) =>
      `<ListItem type="record"><AppliedCharacterStyle type="object">${escapeAttr(styleSelf(doc, 'CharacterStyle', spec.characterStyle))}</AppliedCharacterStyle><GrepExpression type="string">${escapeAttr(spec.pattern)}</GrepExpression></ListItem>`,
  );
  replaceList(style, 'AllGREPStyles', items);
  style.setAttribute('EmptyGrepStyles', items.length ? 'false' : 'true');
}

export interface StyleAutomation {
  nested: { characterStyle: string; through: string; repetition: number; inclusive: boolean }[];
  lines: { characterStyle: string; lines: number; repeat: boolean }[];
  grep: { characterStyle: string; pattern: string }[];
}

export function readStyleAutomation(style: Element): StyleAutomation {
  const props = propertiesOf(style);
  const list = (name: string) => (props ? children(firstChild(props, name), 'ListItem') : []);
  const value = (item: Element, name: string) => firstChild(item, name)?.textContent ?? '';
  return {
    nested: list('AllNestedStyles').map((item) => ({
      characterStyle: value(item, 'AppliedCharacterStyle'),
      through: value(item, 'Delimiter'),
      repetition: Number(value(item, 'Repetition') || 1),
      inclusive: value(item, 'Inclusive') !== 'false',
    })),
    lines: list('AllLineStyles').map((item) => ({
      characterStyle: value(item, 'AppliedCharacterStyle'),
      lines: Number(value(item, 'LineCount') || 1),
      repeat: value(item, 'RepeatLast') !== '0',
    })),
    grep: list('AllGREPStyles').map((item) => ({
      characterStyle: value(item, 'AppliedCharacterStyle'),
      pattern: value(item, 'GrepExpression'),
    })),
  };
}
