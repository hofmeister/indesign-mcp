import type { IdmlDocument } from './document.ts';
import { formatMatrix } from './geometry.ts';
import { appliedMasterOf, documentPageSize, IDENTITY_TRANSFORM, resolveMaster } from './pages.ts';
import { createStory } from './stories.ts';
import {
  attr,
  children,
  createIdPkgRef,
  type Element,
  formatNumber,
  insertAfter,
  removeElement,
  setAttrs,
} from './xml.ts';

/** Gives every text frame inside `container` its own copy of its story (after cloning a master/spread). */
export function duplicateStoriesOf(doc: IdmlDocument, container: Element): void {
  // `container` may itself be the text frame (a single copied item) or hold frames inside it.
  const frames = [
    ...(container.tagName === 'TextFrame' ? [container] : []),
    ...(Array.from(container.getElementsByTagName('TextFrame')) as Element[]),
  ];
  const mapping = new Map<string, string>();
  for (const f of frames) {
    const storyId = attr(f, 'ParentStory');
    if (!storyId) continue;
    let newId = mapping.get(storyId);
    if (!newId) {
      const story = doc.story(storyId);
      const copy = createStory(doc, { text: '' });
      if (story) {
        while (copy.firstChild) copy.removeChild(copy.firstChild);
        for (const c of Array.from(story.childNodes))
          copy.appendChild(copy.ownerDocument!.importNode(c, true));
      }
      newId = attr(copy, 'Self')!;
      mapping.set(storyId, newId);
    }
    f.setAttribute('ParentStory', newId);
  }
  // threading between copied frames must point at the copied ids
  const selfMap = new Map<string, string>();
  for (const f of frames) {
    const prev = attr(f, 'PreviousTextFrame');
    const next = attr(f, 'NextTextFrame');
    void prev;
    void next;
  }
  void selfMap;
}

/**
 * Overrides a master page item on a document page: copies it onto the page (so it can be edited)
 * and hides the master's original by adding its id to the page's OverrideList.
 */
export function overrideMasterItem(doc: IdmlDocument, pageRef: number | string, itemRef: string): Element {
  const { findPage } = require('./pages.ts') as typeof import('./pages.ts');
  const { isPageItem, translateItem } = require('./items.ts') as typeof import('./items.ts');
  const { children, insertAfter } = require('./xml.ts') as typeof import('./xml.ts');
  const page = findPage(doc, pageRef);
  if (!page.appliedMaster) throw new Error(`Page ${page.index} has no master page applied`);
  const master = doc.masterSpreads().find((m) => attr(m, 'Self') === page.appliedMaster);
  if (!master) throw new Error('Master page not found');
  const items = children(master).filter(isPageItem);
  const found =
    items.find((i) => attr(i, 'Self') === itemRef) ??
    items.find((i) => (attr(i, 'Name') ?? '').toLowerCase() === itemRef.toLowerCase());
  if (!found) {
    const names = items
      .map((i) =>
        attr(i, 'Name') && attr(i, 'Name') !== '$ID/' ? `"${attr(i, 'Name')}"` : (attr(i, 'Self') ?? ''),
      )
      .join(', ');
    throw new Error(
      `Item "${itemRef}" not found on master ${attr(master, 'Name')}. It has: ${names || 'no items'}`,
    );
  }
  const masterId = attr(found, 'Self')!;
  const pageEl = doc.findBySelf(page.id)?.element;
  const spread = doc.findBySelf(page.spreadId)?.element;
  if (!pageEl || !spread) throw new Error('Page or spread not found');
  const overrides = (attr(pageEl, 'OverrideList') ?? '').split(/\s+/).filter(Boolean);
  if (overrides.includes(masterId))
    throw new Error(`"${itemRef}" is already overridden on page ${page.index}`);

  const spreadDoc = doc.xml(page.spreadPart);
  const clone = spreadDoc.importNode(found, true) as Element;
  for (const el of [clone, ...(Array.from(clone.getElementsByTagName('*')) as Element[])]) {
    if (el.hasAttribute?.('Self')) el.setAttribute('Self', doc.newId());
  }
  duplicateStoriesOf(doc, clone);
  insertAfter(spread, clone);
  // master pages have their own origin; move the copy to the same spot on this page
  const mpages = children(master, 'Page');
  const mpage =
    mpages.length > 1 ? (page.side === 'left' ? mpages[0]! : mpages[mpages.length - 1]!) : mpages[0];
  if (mpage) {
    const mt = (attr(mpage, 'ItemTransform') ?? '1 0 0 1 0 0').split(/\s+/).map(Number);
    const mb = (attr(mpage, 'GeometricBounds') ?? '0 0 0 0').split(/\s+/).map(Number);
    const originX = (mt[4] ?? 0) + (mb[1] ?? 0);
    const originY = (mt[5] ?? 0) + (mb[0] ?? 0);
    translateItem(clone, page.origin.x - originX, page.origin.y - originY);
  }
  overrides.push(masterId);
  pageEl.setAttribute('OverrideList', overrides.join(' '));
  return clone;
}

// ---- master spreads ------------------------------------------------------------------------------

/** The MasterSpread element and the part it lives in. */
export function masterSpread(doc: IdmlDocument, ref: string): { element: Element; part: string } {
  const id = resolveMaster(doc, ref);
  for (const part of doc.masterSpreadParts()) {
    const ms = children(doc.xml(part).documentElement, 'MasterSpread')[0];
    if (ms && attr(ms, 'Self') === id) return { element: ms, part };
  }
  throw new Error(`Master page "${ref}" not found`);
}

export interface MasterSpec {
  prefix: string;
  name: string;
  /** Master to copy (default: the first one). */
  copyFrom?: string;
  /** Copy the source master's items (default true). */
  keepItems?: boolean;
  /** Pages in the spread: 1 for a single page, 2 for facing pages, more for a gatefold. */
  pages?: number;
  /** Another master this one is based on, so its items show through. */
  basedOn?: string;
}

/** Creates a master spread, copied from another one. */
export function createMaster(doc: IdmlDocument, spec: MasterSpec): { id: string; name: string } {
  if (
    doc
      .masterSpreads()
      .some((m) => (attr(m, 'Name') ?? '').toLowerCase() === `${spec.prefix}-${spec.name}`.toLowerCase())
  )
    throw new Error(`A master page called "${spec.prefix}-${spec.name}" already exists`);
  const source = masterSpread(doc, spec.copyFrom ?? attr(doc.masterSpreads()[0]!, 'Self')!);
  const id = doc.newId();
  const part = `MasterSpreads/MasterSpread_${id}.xml`;
  const partDoc = doc.newPartDocument('MasterSpread');
  const clone = partDoc.importNode(source.element, true) as Element;
  setAttrs(clone, {
    Self: id,
    Name: `${spec.prefix}-${spec.name}`,
    NamePrefix: spec.prefix,
    BaseName: spec.name,
  });
  for (const el of Array.from(clone.getElementsByTagName('*')) as Element[]) {
    if (el.hasAttribute('Self')) el.setAttribute('Self', doc.newId());
    if (el.tagName === 'Page') el.setAttribute('Name', spec.prefix);
  }
  if (spec.keepItems === false) {
    for (const el of children(clone))
      if (!['Page', 'Properties', 'FlattenerPreference'].includes(el.tagName)) clone.removeChild(el);
  } else {
    duplicateStoriesOf(doc, clone);
  }
  partDoc.documentElement!.appendChild(partDoc.createTextNode('\n\t'));
  partDoc.documentElement!.appendChild(clone);
  partDoc.documentElement!.appendChild(partDoc.createTextNode('\n'));
  doc.addXmlPart(part, partDoc);
  const ref = createIdPkgRef(doc.designmap, 'MasterSpread', part);
  const refs = children(doc.root).filter((c) => c.tagName === 'idPkg:MasterSpread');
  insertAfter(doc.root, ref, refs.at(-1));
  if (spec.pages !== undefined) setMasterPageCount(doc, id, spec.pages);
  if (spec.basedOn) setMasterParent(doc, id, spec.basedOn);
  return { id, name: `${spec.prefix}-${spec.name}` };
}

/** Renames a master spread and its pages. */
export function renameMaster(
  doc: IdmlDocument,
  ref: string,
  options: { prefix?: string; name?: string },
): { id: string; name: string } {
  const { element } = masterSpread(doc, ref);
  const prefix = options.prefix ?? attr(element, 'NamePrefix') ?? 'A';
  const base = options.name ?? attr(element, 'BaseName') ?? 'Master';
  const full = `${prefix}-${base}`;
  if (
    doc
      .masterSpreads()
      .some((m) => m !== element && (attr(m, 'Name') ?? '').toLowerCase() === full.toLowerCase())
  )
    throw new Error(`A master page called "${full}" already exists`);
  setAttrs(element, { Name: full, NamePrefix: prefix, BaseName: base });
  for (const page of children(element, 'Page')) page.setAttribute('Name', prefix);
  return { id: attr(element, 'Self')!, name: full };
}

/**
 * Deletes a master spread. Pages using it fall back to `replaceWith` (or to no master), and so do
 * masters based on it.
 */
export function deleteMaster(doc: IdmlDocument, ref: string, replaceWith?: string): { pages: number } {
  const { element, part } = masterSpread(doc, ref);
  const id = attr(element, 'Self')!;
  if (doc.masterSpreads().length <= 1) throw new Error('A document needs at least one master page');
  const replacement = replaceWith ? resolveMaster(doc, replaceWith) : undefined;
  if (replacement === id) throw new Error('A master cannot be replaced by itself');
  let touched = 0;
  const repoint = (page: Element) => {
    if (appliedMasterOf(page) !== id) return;
    page.setAttribute('AppliedMaster', replacement ?? 'n');
    touched++;
  };
  for (const spread of doc.spreads()) for (const page of children(spread, 'Page')) repoint(page);
  for (const other of doc.masterSpreads())
    if (other !== element) for (const page of children(other, 'Page')) repoint(page);
  doc.removePart(part);
  const idRef = children(doc.root).find((c) => c.tagName === 'idPkg:MasterSpread' && attr(c, 'src') === part);
  if (idRef) removeElement(idRef);
  return { pages: touched };
}

/**
 * Sets how many pages a master spread has: one for a single-sided document, two for facing pages,
 * more for a gatefold. Pages are added or removed at the end, and the remaining ones re-laid out.
 */
export function setMasterPageCount(doc: IdmlDocument, ref: string, count: number): number {
  const { element } = masterSpread(doc, ref);
  const wanted = Math.max(1, Math.min(10, Math.floor(count)));
  const pages = children(element, 'Page');
  const size = documentPageSize(doc);
  if (wanted < pages.length) for (const extra of pages.slice(wanted)) removeElement(extra);
  for (let i = pages.length; i < wanted; i++) {
    const copy = element.ownerDocument!.importNode(pages[0]!, true) as Element;
    copy.setAttribute('Self', doc.newId());
    copy.removeAttribute('OverrideList');
    element.appendChild(copy);
  }
  element.setAttribute('PageCount', String(wanted));
  const now = children(element, 'Page');
  now.forEach((page, i) => {
    setAttrs(page, {
      GeometricBounds: `0 0 ${formatNumber(size.height)} ${formatNumber(size.width)}`,
      // Pages of a spread sit side by side; the first starts at the spine for facing pages.
      ItemTransform: formatMatrix([
        1,
        0,
        0,
        1,
        now.length === 1 ? -size.width / 2 : (i - 1) * size.width,
        -size.height / 2,
      ]),
      MasterPageTransform: IDENTITY_TRANSFORM,
    });
  });
  return wanted;
}

/** Bases a master on another master (or on none), the way InDesign's "Based on Master" does. */
export function setMasterParent(doc: IdmlDocument, ref: string, parent: string | undefined): void {
  const { element } = masterSpread(doc, ref);
  const id = attr(element, 'Self')!;
  const parentId = parent && parent !== 'none' ? resolveMaster(doc, parent) : undefined;
  if (parentId === id) throw new Error('A master cannot be based on itself');
  if (parentId) {
    // Walking up from the parent must not lead back here, or InDesign loops on open.
    let current = parentId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const spread = doc.masterSpreads().find((m) => attr(m, 'Self') === current);
      const next = spread ? appliedMasterOf(children(spread, 'Page')[0]) : undefined;
      if (next === id) throw new Error('That would base the two masters on each other');
      current = next ?? '';
    }
  }
  for (const page of children(element, 'Page')) page.setAttribute('AppliedMaster', parentId ?? 'n');
}
