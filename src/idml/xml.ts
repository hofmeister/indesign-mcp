// XML helpers on top of @xmldom/xmldom. IDML parts are order and whitespace sensitive
// (text inside <Content> is real text), so nothing here pretty-prints.
import { DOMParser, type Document, type Element, type Node, XMLSerializer } from '@xmldom/xmldom';

export type { Document, Element, Node };

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export function parseXml(text: string, partName = 'xml'): Document {
  let error: string | undefined;
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level === 'fatalError' || level === 'error') error ??= message;
    },
  });
  const doc = parser.parseFromString(text, 'text/xml');
  if (error || !doc.documentElement) {
    throw new Error(`Malformed XML in ${partName}: ${error ?? 'no root element'}`);
  }
  return doc;
}

/** Serializes a document, re-adding the XML declaration xmldom drops. */
export function serializeXml(doc: Document): string {
  const body = new XMLSerializer().serializeToString(doc);
  return body.startsWith('<?xml') ? body : `${XML_DECLARATION}\n${body}`;
}

/** Direct element children, optionally filtered by tag name. */
export function children(el: Node | null | undefined, tagName?: string): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!tagName || (n as Element).tagName === tagName)) out.push(n as Element);
  }
  return out;
}

export function firstChild(el: Node | null | undefined, tagName: string): Element | undefined {
  return children(el, tagName)[0];
}

/** All descendant elements with the given tag name (document order). */
export function descendants(el: Node, tagName: string): Element[] {
  const out: Element[] = [];
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) {
        if ((c as Element).tagName === tagName) out.push(c as Element);
        walk(c);
      }
    }
  };
  walk(el);
  return out;
}

/** Every element in the subtree (document order), including the root if it is an element. */
export function allElements(root: Node): Element[] {
  const out: Element[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 1) out.push(n as Element);
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(root);
  return out;
}

export function attr(el: Element, name: string): string | undefined {
  return el.hasAttribute(name) ? el.getAttribute(name)! : undefined;
}

export function numAttr(el: Element, name: string, fallback = 0): number {
  const v = attr(el, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Sets several attributes at once; `undefined` values are skipped, `null` removes the attribute. */
export function setAttrs(
  el: Element,
  attrs: Record<string, string | number | boolean | null | undefined>,
): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (v === null) el.removeAttribute(k);
    else el.setAttribute(k, typeof v === 'number' ? formatNumber(v) : String(v));
  }
}

/** Numbers the way InDesign writes them: no exponent, no trailing zeros, up to 6 decimals. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * Returns the `<Properties>` child of an element, creating it as the first child when missing
 * (IDML always writes Properties before other children).
 */
export function propertiesOf(el: Element, create: true): Element;
export function propertiesOf(el: Element, create?: false): Element | undefined;
export function propertiesOf(el: Element, create = false): Element | undefined {
  let props = firstChild(el, 'Properties');
  if (!props && create) {
    props = ownerDoc(el).createElement('Properties');
    el.insertBefore(props, el.firstChild);
  }
  return props;
}

/** The owning document of a node (never null for nodes that live in a document). */
export function ownerDoc(node: Node): Document {
  const d = node.ownerDocument;
  if (!d) throw new Error('Node has no owner document');
  return d;
}

/** Appends a new element child and returns it typed as Element. */
export function appendElement(parent: Element, tagName: string): Element {
  const el = ownerDoc(parent).createElement(tagName);
  parent.appendChild(el);
  return el;
}

/** Reads a typed property such as <Leading type="unit">14</Leading>. */
export function getProperty(
  el: Element,
  name: string,
): { type: string | undefined; value: string } | undefined {
  const props = propertiesOf(el);
  const p = props ? firstChild(props, name) : undefined;
  if (!p) return undefined;
  return { type: attr(p, 'type'), value: p.textContent ?? '' };
}

/** Writes a typed property, replacing an existing one. `value === null` removes it. */
export function setProperty(el: Element, name: string, type: string, value: string | number | null): void {
  const props = propertiesOf(el, true);
  const existing = firstChild(props, name);
  if (value === null) {
    if (existing) props.removeChild(existing);
    if (!children(props).length) el.removeChild(props);
    return;
  }
  const p = existing ?? appendElement(props, name);
  p.setAttribute('type', type);
  while (p.firstChild) p.removeChild(p.firstChild);
  p.appendChild(ownerDoc(el).createTextNode(typeof value === 'number' ? formatNumber(value) : value));
}

/** Parses an element from an XML fragment and imports it into `doc`. */
export function fragment(doc: Document, xml: string): Element {
  const parsed = parseXml(
    `<Root xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">${xml}</Root>`,
    'fragment',
  );
  const el = children(parsed.documentElement)[0];
  if (!el) throw new Error('fragment has no element');
  return doc.importNode(el, true) as Element;
}

/** Removes an element from its parent along with the whitespace text node preceding it. */
export function removeElement(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  const prev = el.previousSibling;
  if (prev && prev.nodeType === 3 && !(prev.textContent ?? '').trim()) parent.removeChild(prev);
  parent.removeChild(el);
}

/** Inserts `el` after `ref` (or as last child of `parent` if ref is undefined), copying indentation. */
export function insertAfter(parent: Element, el: Element, ref?: Element): void {
  const doc = ownerDoc(parent);
  const indentOf = (node: Node | null): string => {
    if (node?.previousSibling?.nodeType === 3) {
      const t = node.previousSibling.textContent ?? '';
      const m = /\n([\t ]*)$/.exec(t);
      if (m) return `\n${m[1]}`;
    }
    return '';
  };
  if (ref) {
    const indent = indentOf(ref);
    const next = ref.nextSibling; // may be null (append)
    if (indent) parent.insertBefore(doc.createTextNode(indent), next);
    parent.insertBefore(el, next);
  } else {
    const lastEl = children(parent).at(-1);
    const indent = lastEl ? indentOf(lastEl) : '';
    const closingWs = parent.lastChild?.nodeType === 3 ? parent.lastChild : null;
    if (indent) parent.insertBefore(doc.createTextNode(indent), closingWs);
    parent.insertBefore(el, closingWs);
  }
}

export const IDPKG_NAMESPACE = 'http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging';

/** Creates an `<idPkg:Kind src="..."/>` reference element in the IDML packaging namespace. */
export function createIdPkgRef(doc: Document, kind: string, src: string): Element {
  const el = doc.createElementNS(IDPKG_NAMESPACE, `idPkg:${kind}`);
  el.setAttribute('src', src);
  return el;
}
