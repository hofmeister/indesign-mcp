// Reordering, moving and duplicating pages: rebuilds the spread layout the way InDesign does.
// Pages are taken apart with the items that sit on them, put in the wanted order, and written back
// into freshly laid-out spreads. Item-to-page ownership is tracked explicitly, never re-guessed
// from geometry, so pages that overlap during the operation cannot mix their content up.
import type { IdmlDocument } from './document.ts';
import { formatMatrix } from './geometry.ts';
import { isPageItem, itemSpreadBounds, translateItem } from './items.ts';
import { duplicateStoriesOf } from './masters.ts';
import {
  findPage,
  isFacingPages,
  listPages,
  newSpread,
  type PageInfo,
  pageForSpreadRect,
  pageTransform,
  updatePageCounts,
} from './pages.ts';
import { attr, children, type Element, insertAfter, removeElement } from './xml.ts';

interface DetachedPage {
  id: string;
  page: Element;
  items: Element[];
  /** Where the page sat when it was detached (spread coordinates). */
  origin: { x: number; y: number };
  width: number;
  height: number;
}

/** Takes every page (with the items sitting on it) out of its spread. */
function detachPages(doc: IdmlDocument): DetachedPage[] {
  const infos = listPages(doc);
  const out: DetachedPage[] = [];
  const claimed = new Set<Element>();
  for (const info of infos) {
    const spread = doc.findBySelf(info.spreadId)?.element;
    if (!spread) continue;
    const pageEl = children(spread, 'Page').find((p) => attr(p, 'Self') === info.id);
    if (!pageEl) continue;
    const items: Element[] = [];
    for (const el of children(spread)) {
      if (!isPageItem(el) || claimed.has(el)) continue;
      const b = itemSpreadBounds(el);
      if (!b) continue;
      if (pageForSpreadRect(infos, info.spreadId, b)?.id === info.id) {
        items.push(el);
        claimed.add(el);
      }
    }
    out.push({
      id: info.id,
      page: pageEl,
      items,
      origin: info.origin,
      width: info.width,
      height: info.height,
    });
  }
  // items that belong to no page (e.g. on the pasteboard) stay with the first page of their spread
  for (const info of infos) {
    const spread = doc.findBySelf(info.spreadId)?.element;
    if (!spread) continue;
    const target = out.find((d) => d.id === info.id);
    if (!target) continue;
    for (const el of children(spread)) {
      if (!isPageItem(el) || claimed.has(el)) continue;
      target.items.push(el);
      claimed.add(el);
    }
  }
  for (const d of out) {
    removeElement(d.page);
    for (const el of d.items) removeElement(el);
  }
  return out;
}

/** Spread layout for `count` pages: single pages, or page 1 alone then pairs for facing documents. */
export function spreadLayout(count: number, facing: boolean): number[] {
  if (!facing) return Array.from({ length: count }, () => 1);
  const out: number[] = [];
  let remaining = count;
  if (remaining > 0) {
    out.push(1);
    remaining--;
  }
  while (remaining > 0) {
    out.push(Math.min(2, remaining));
    remaining -= Math.min(2, remaining);
  }
  return out;
}

/** Writes detached pages back into freshly laid-out spreads, in the given order. */
function rebuild(doc: IdmlDocument, ordered: DetachedPage[]): PageInfo[] {
  const facing = isFacingPages(doc);
  const layout = spreadLayout(ordered.length, facing);

  // reuse existing spread parts, adding or removing as needed
  const parts = doc.spreadParts();
  while (parts.length < layout.length) {
    const created = newSpread(doc, parts.at(-1), undefined);
    parts.push(created.part);
  }
  for (const extra of parts.slice(layout.length)) {
    doc.removePart(extra);
    const ref = children(doc.root).find((c) => c.tagName === 'idPkg:Spread' && attr(c, 'src') === extra);
    if (ref) removeElement(ref);
  }
  const usedParts = parts.slice(0, layout.length);

  let index = 0;
  for (let s = 0; s < layout.length; s++) {
    const part = usedParts[s]!;
    const spreadDoc = doc.xml(part);
    const spread = children(spreadDoc.documentElement, 'Spread')[0]!;
    for (const el of children(spread)) if (el.tagName === 'Page' || isPageItem(el)) removeElement(el);
    const pagesHere = layout[s]!;
    let lastPage: Element | undefined;
    const placed: { page: Element; detached: DetachedPage; origin: { x: number; y: number } }[] = [];
    for (let i = 0; i < pagesHere; i++) {
      const d = ordered[index + i]!;
      const side: 'left' | 'right' | 'single' = !facing
        ? 'single'
        : pagesHere === 1
          ? s === 0
            ? 'right'
            : 'left'
          : i === 0
            ? 'left'
            : 'right';
      const transform = pageTransform(d.width, d.height, facing, side);
      const imported = spreadDoc.importNode(d.page, true) as Element;
      imported.setAttribute('ItemTransform', formatMatrix(transform));
      insertAfter(spread, imported, lastPage);
      lastPage = imported;
      placed.push({ page: imported, detached: d, origin: { x: transform[4], y: transform[5] } });
    }
    // items come after all pages of the spread, moved by the shift of their own page
    for (const { detached, origin } of placed) {
      const dx = origin.x - detached.origin.x;
      const dy = origin.y - detached.origin.y;
      for (const item of detached.items) {
        const imported = spreadDoc.importNode(item, true) as Element;
        if (dx || dy) translateItem(imported, dx, dy);
        insertAfter(spread, imported);
      }
    }
    index += pagesHere;
  }
  updatePageCounts(doc);
  return listPages(doc);
}

/**
 * Rebuilds the document's spreads so the pages appear in `order` (page Self ids).
 * Items keep their position relative to their page.
 */
export function reflowPages(doc: IdmlDocument, order: string[]): PageInfo[] {
  const detached = detachPages(doc);
  const byId = new Map(detached.map((d) => [d.id, d]));
  const ordered = order.map((id) => byId.get(id)).filter((d): d is DetachedPage => !!d);
  for (const d of detached) if (!ordered.includes(d)) ordered.push(d);
  return rebuild(doc, ordered);
}

/** Moves a page to a new 1-based position. */
export function movePage(doc: IdmlDocument, from: number | string, to: number): PageInfo[] {
  const pages = listPages(doc);
  const page = findPage(doc, from);
  const order = pages.map((p) => p.id).filter((id) => id !== page.id);
  const target = Math.max(1, Math.min(pages.length, Math.floor(to)));
  order.splice(target - 1, 0, page.id);
  return reflowPages(doc, order);
}

/** Duplicates a page with everything on it. `after` is a 1-based page number (0 = at the front). */
export function duplicatePage(doc: IdmlDocument, source: number | string, after?: number): PageInfo {
  const src = findPage(doc, source);
  const detached = detachPages(doc);
  const original = detached.find((d) => d.id === src.id);
  if (!original) throw new Error(`Page ${source} not found`);

  const copyId = doc.newId();
  const pageCopy = original.page.cloneNode(true) as Element;
  pageCopy.setAttribute('Self', copyId);
  pageCopy.setAttribute('OverrideList', '');
  const itemCopies = original.items.map((item) => {
    const clone = item.cloneNode(true) as Element;
    for (const el of [clone, ...(Array.from(clone.getElementsByTagName('*')) as Element[])]) {
      if (el.hasAttribute?.('Self')) el.setAttribute('Self', doc.newId());
    }
    duplicateStoriesOf(doc, clone);
    return clone;
  });
  const copy: DetachedPage = {
    id: copyId,
    page: pageCopy,
    items: itemCopies,
    origin: original.origin,
    width: original.width,
    height: original.height,
  };

  const ordered = [...detached];
  const srcIndex = ordered.indexOf(original);
  const at = after !== undefined ? Math.max(0, Math.min(ordered.length, Math.floor(after))) : srcIndex + 1;
  ordered.splice(at, 0, copy);
  const pages = rebuild(doc, ordered);
  return pages.find((p) => p.id === copyId)!;
}
