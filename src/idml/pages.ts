// Spreads and pages: listing, geometry and adding pages.
import type { IdmlDocument } from './document.ts';
import {
  apply,
  formatMatrix,
  IDENTITY,
  invert,
  type Matrix,
  type Point,
  parseMatrix,
  type Rect,
} from './geometry.ts';
import {
  attr,
  children,
  createIdPkgRef,
  type Element,
  firstChild,
  formatNumber,
  fragment,
  insertAfter,
  numAttr,
  removeElement,
  setAttrs,
} from './xml.ts';

export interface PageInfo {
  /** 1-based index in the document (physical page order). */
  index: number;
  /** Page name as InDesign shows it (section numbering), e.g. "3" or "iv". */
  name: string;
  id: string;
  spreadId: string;
  spreadPart: string;
  /** Position of the page within its spread, 0-based from the left. */
  positionInSpread: number;
  side: 'left' | 'right' | 'single';
  width: number;
  height: number;
  /** Page top-left in spread coordinates (points). */
  origin: Point;
  /** ItemTransform of the page element. */
  transform: Matrix;
  appliedMaster: string | undefined;
  margins: { top: number; bottom: number; left: number; right: number };
  columns: { count: number; gutter: number };
}

/** GeometricBounds are "top left bottom right". */
export function parseBounds(s: string | undefined): {
  top: number;
  left: number;
  bottom: number;
  right: number;
} {
  const [top = 0, left = 0, bottom = 0, right = 0] = (s ?? '').trim().split(/\s+/).map(Number);
  return { top, left, bottom, right };
}

export function pageElements(spread: Element): Element[] {
  return children(spread, 'Page');
}

export function pageInfoFor(
  doc: IdmlDocument,
  spread: Element,
  spreadPart: string,
  page: Element,
  index: number,
  position: number,
): PageInfo {
  const b = parseBounds(attr(page, 'GeometricBounds'));
  const transform = parseMatrix(attr(page, 'ItemTransform'));
  const origin = apply(transform, { x: b.left, y: b.top });
  const width = b.right - b.left;
  const height = b.bottom - b.top;
  const facing = isFacingPages(doc);
  const margin = firstChild(page, 'MarginPreference');
  let side: PageInfo['side'] = 'single';
  if (facing) side = origin.x + width / 2 < 0 ? 'left' : 'right';
  return {
    index,
    name: attr(page, 'Name') ?? String(index),
    id: attr(page, 'Self') ?? '',
    spreadId: attr(spread, 'Self') ?? '',
    spreadPart,
    positionInSpread: position,
    side,
    width,
    height,
    origin,
    transform,
    appliedMaster: attr(page, 'AppliedMaster') === 'n' ? undefined : attr(page, 'AppliedMaster'),
    margins: {
      top: numAttr(margin!, 'Top', 0),
      bottom: numAttr(margin!, 'Bottom', 0),
      left: numAttr(margin!, 'Left', 0),
      right: numAttr(margin!, 'Right', 0),
    },
    columns: { count: numAttr(margin!, 'ColumnCount', 1), gutter: numAttr(margin!, 'ColumnGutter', 12) },
  };
}

export function listPages(doc: IdmlDocument): PageInfo[] {
  const out: PageInfo[] = [];
  let index = 1;
  for (const part of doc.spreadParts()) {
    const spread = children(doc.xml(part).documentElement, 'Spread')[0];
    if (!spread) continue;
    pageElements(spread).forEach((page, pos) => {
      out.push(pageInfoFor(doc, spread, part, page, index++, pos));
    });
  }
  return out;
}

/** Resolves a page by 1-based index, by InDesign page name, or by Self id. */
export function findPage(doc: IdmlDocument, ref: number | string): PageInfo {
  const pages = listPages(doc);
  if (!pages.length) throw new Error('The document has no pages');
  if (typeof ref === 'number' || /^\d+$/.test(ref)) {
    const n = Number(ref);
    const byIndex = pages.find((p) => p.index === n);
    if (byIndex) return byIndex;
    const byName = pages.find((p) => p.name === String(ref));
    if (byName) return byName;
    throw new Error(
      `Page ${ref} does not exist (the document has ${pages.length} page${pages.length === 1 ? '' : 's'})`,
    );
  }
  const found =
    pages.find((p) => p.id === ref) ?? pages.find((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (!found) throw new Error(`Page "${ref}" not found`);
  return found;
}

export function documentPreference(doc: IdmlDocument): Element {
  const prefs = doc.resource('Preferences');
  const dp = firstChild(prefs, 'DocumentPreference');
  if (!dp) throw new Error('Preferences.xml has no DocumentPreference');
  return dp;
}

export function isFacingPages(doc: IdmlDocument): boolean {
  return attr(documentPreference(doc), 'FacingPages') === 'true';
}

export function documentPageSize(doc: IdmlDocument): { width: number; height: number } {
  const dp = documentPreference(doc);
  return { width: numAttr(dp, 'PageWidth', 595.2756), height: numAttr(dp, 'PageHeight', 841.8898) };
}

/** Converts a page-relative point (from the page's top-left) to spread coordinates. */
export function pageToSpread(page: PageInfo, p: Point): Point {
  return { x: page.origin.x + p.x, y: page.origin.y + p.y };
}

export function spreadToPage(page: PageInfo, p: Point): Point {
  return { x: p.x - page.origin.x, y: p.y - page.origin.y };
}

export function pageRectToSpread(page: PageInfo, r: Rect): Rect {
  return { x: page.origin.x + r.x, y: page.origin.y + r.y, width: r.width, height: r.height };
}

/** Which page of the spread a spread-space rectangle belongs to (by its center), if any. */
export function pageForSpreadRect(pages: PageInfo[], spreadId: string, r: Rect): PageInfo | undefined {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const candidates = pages.filter((p) => p.spreadId === spreadId);
  const hit = candidates.find(
    (p) => cx >= p.origin.x && cx <= p.origin.x + p.width && cy >= p.origin.y && cy <= p.origin.y + p.height,
  );
  if (hit) return hit;
  // nearest page horizontally
  let best: PageInfo | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of candidates) {
    const d = Math.abs(p.origin.x + p.width / 2 - cx);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

// ---- page count bookkeeping --------------------------------------------------------------

/**
 * PagesPerDocument is *not* the document's page count: it is the "Pages" field of InDesign's New
 * Document dialog. On import InDesign first creates a document with that many pages and only then
 * reads the spreads, so anything above 1 leaves that many blank pages in front of the real ones.
 * InDesign itself always writes 1, whatever the document holds — so we do too, on every save.
 */
export function pinPagesPerDocument(doc: IdmlDocument): void {
  const prefs = documentPreference(doc);
  if (prefs.getAttribute('PagesPerDocument') !== '1') prefs.setAttribute('PagesPerDocument', '1');
}

export function updatePageCounts(doc: IdmlDocument): void {
  let total = 0;
  for (const part of doc.spreadParts()) {
    const spread = children(doc.xml(part).documentElement, 'Spread')[0];
    if (!spread) continue;
    const n = pageElements(spread).length;
    spread.setAttribute('PageCount', String(n));
    total += n;
  }
  pinPagesPerDocument(doc);
  // Keep a single section covering all pages (multi-section documents keep their first section start).
  const sections = children(doc.root, 'Section');
  if (sections.length === 1) {
    sections[0]!.setAttribute('Length', String(total));
  } else if (sections.length > 1) {
    // Extend the last section by the difference.
    const sum = sections.reduce((s, sec) => s + numAttr(sec, 'Length', 0), 0);
    const last = sections.at(-1)!;
    last.setAttribute('Length', String(Math.max(1, numAttr(last, 'Length', 0) + (total - sum))));
  }
  // Page names (display numbers) for the simple single-section case
  if (sections.length <= 1) {
    const start = sections[0] ? numAttr(sections[0], 'PageNumberStart', 1) || 1 : 1;
    listPages(doc).forEach((p) => {
      const el = doc.findBySelf(p.id)?.element;
      if (el) el.setAttribute('Name', String(start + p.index - 1));
    });
    if (sections[0]) {
      const first = listPages(doc)[0];
      if (first) sections[0].setAttribute('PageStart', first.id);
    }
  }
}

/**
 * The transform a page applies to the master it inherits. A page and its master are the same size
 * here, so it is always identity — but InDesign obeys a stale one and draws master items offset.
 */
export const IDENTITY_TRANSFORM = '1 0 0 1 0 0';

/** ItemTransform for a page at `position` (0 = left) in a spread with `count` pages. */
export function pageTransform(
  width: number,
  height: number,
  facing: boolean,
  side: 'left' | 'right' | 'single',
): Matrix {
  const ty = -height / 2;
  if (!facing || side === 'single') return [1, 0, 0, 1, -width / 2, ty];
  return side === 'left' ? [1, 0, 0, 1, -width, ty] : [1, 0, 0, 1, 0, ty];
}

export function newSpread(
  doc: IdmlDocument,
  afterPart: string | undefined,
  template: Element | undefined,
): { spread: Element; part: string } {
  const id = doc.newId();
  const part = `Spreads/Spread_${id}.xml`;
  const partDoc = doc.newPartDocument('Spread');
  let spread: Element;
  if (template) {
    spread = partDoc.importNode(template, false) as Element;
    // keep only FlattenerPreference
    const flattener = firstChild(template, 'FlattenerPreference');
    if (flattener) spread.appendChild(partDoc.importNode(flattener, true));
  } else {
    spread = fragment(
      partDoc,
      `<Spread PageTransitionType="None" PageTransitionDirection="NotApplicable" PageTransitionDuration="Medium" ShowMasterItems="true" PageCount="0" BindingLocation="0" AllowPageShuffle="true" ItemTransform="1 0 0 1 0 0" FlattenerOverride="Default"><FlattenerPreference LineArtAndTextResolution="300" GradientAndMeshResolution="150" ClipComplexRegions="false" ConvertAllStrokesToOutlines="false" ConvertAllTextToOutlines="false"><Properties><RasterVectorBalance type="double">50</RasterVectorBalance></Properties></FlattenerPreference></Spread>`,
    );
  }
  setAttrs(spread, { Self: id, PageCount: 0, BindingLocation: 0 });
  partDoc.documentElement!.appendChild(partDoc.createTextNode('\n\t'));
  partDoc.documentElement!.appendChild(spread);
  partDoc.documentElement!.appendChild(partDoc.createTextNode('\n'));
  doc.addXmlPart(part, partDoc);
  // designmap reference
  const ref = createIdPkgRef(doc.designmap, 'Spread', part);
  const refs = children(doc.root).filter((c) => c.tagName === 'idPkg:Spread');
  const anchor = afterPart ? refs.find((r) => attr(r, 'src') === afterPart) : refs.at(-1);
  insertAfter(
    doc.root,
    ref,
    anchor ?? children(doc.root).find((c) => c.tagName === 'idPkg:MasterSpread') ?? refs.at(-1),
  );
  return { spread, part };
}

export interface AddPagesOptions {
  count?: number;
  /** Insert after this page (1-based). Default: at the end. Only appending is supported for now. */
  after?: number;
  master?: string | 'none';
}

/**
 * Appends pages, following InDesign's spread layout: single-page spreads for non-facing documents;
 * for facing documents page 1 stands alone on the right, then pairs (left, right).
 */
export function addPages(doc: IdmlDocument, options: AddPagesOptions = {}): PageInfo[] {
  const count = Math.max(1, Math.floor(options.count ?? 1));
  const facing = isFacingPages(doc);
  const size = documentPageSize(doc);
  const added: string[] = [];
  const masterId = resolveMaster(doc, options.master);

  for (let i = 0; i < count; i++) {
    const pages = listPages(doc);
    const last = pages.at(-1);
    let target: { spread: Element; part: string };
    let side: PageInfo['side'] = 'single';
    const templatePage = last ? doc.findBySelf(last.id)?.element : undefined;
    const lastSpread = last ? children(doc.xml(last.spreadPart).documentElement, 'Spread')[0] : undefined;

    if (!facing) {
      target = newSpread(doc, last?.spreadPart, lastSpread);
    } else if (last && lastSpread && pageElements(lastSpread).length === 1 && last.side === 'left') {
      target = { spread: lastSpread, part: last.spreadPart };
      side = 'right';
    } else if (!last) {
      target = newSpread(doc, undefined, undefined);
      side = 'right';
    } else {
      target = newSpread(doc, last.spreadPart, lastSpread);
      side = 'left';
    }

    const id = doc.newId();
    const partDoc = doc.xml(target.part);
    let page: Element;
    if (templatePage) {
      page = partDoc.importNode(templatePage, true) as Element;
    } else {
      page = fragment(
        partDoc,
        `<Page TabOrder="" AppliedMaster="n" OverrideList="" MasterPageTransform="1 0 0 1 0 0" Name="1" AppliedTrapPreset="TrapPreset/$ID/kDefaultTrapStyleName" GeometricBounds="0 0 ${formatNumber(size.height)} ${formatNumber(size.width)}" ItemTransform="1 0 0 1 0 0" LayoutRule="Off" SnapshotBlendingMode="IgnoreLayoutSnapshots" OptionalPage="false" GridStartingPoint="TopOutside" UseMasterGrid="true"><Properties><PageColor type="enumeration">UseMasterColor</PageColor></Properties><MarginPreference ColumnCount="1" ColumnGutter="12" Top="36" Bottom="36" Left="36" Right="36" ColumnDirection="Horizontal" ColumnsPositions="0 ${formatNumber(size.width - 72)}"/></Page>`,
      );
    }
    const transform = pageTransform(size.width, size.height, facing, side);
    setAttrs(page, {
      Self: id,
      Name: String((last?.index ?? 0) + 1),
      OverrideList: '',
      GeometricBounds: `0 0 ${formatNumber(size.height)} ${formatNumber(size.width)}`,
      ItemTransform: formatMatrix(transform),
      MasterPageTransform: IDENTITY_TRANSFORM,
    });
    if (options.master !== undefined) page.setAttribute('AppliedMaster', masterId ?? 'n');
    // Insert after the last Page element (or after FlattenerPreference) so items stay after pages... pages come first in InDesign output
    const existingPages = pageElements(target.spread);
    insertAfter(
      target.spread,
      page,
      existingPages.at(-1) ?? firstChild(target.spread, 'FlattenerPreference'),
    );
    added.push(id);
  }
  updatePageCounts(doc);
  const all = listPages(doc);
  return all.filter((p) => added.includes(p.id));
}

/** Resolves a master by name ("A-Master"), prefix ("A") or id. "none" -> undefined. */
export function resolveMaster(doc: IdmlDocument, ref: string | undefined): string | undefined {
  if (!ref || ref === 'none') return undefined;
  for (const m of doc.masterSpreads()) {
    const self = attr(m, 'Self');
    if (self === ref) return self;
    const name = attr(m, 'Name') ?? '';
    const prefix = attr(m, 'NamePrefix') ?? '';
    const base = attr(m, 'BaseName') ?? '';
    if ([name, `${prefix}-${base}`, prefix, base].some((n) => n.toLowerCase() === ref.toLowerCase()))
      return self;
  }
  throw new Error(
    `Master page "${ref}" not found. Available: ${
      doc
        .masterSpreads()
        .map((m) => attr(m, 'Name'))
        .join(', ') || 'none'
    }`,
  );
}

export function removePages(doc: IdmlDocument, refs: (number | string)[]): number {
  const pages = listPages(doc);
  if (refs.length >= pages.length) throw new Error('A document must keep at least one page');
  const targets = refs.map((r) => findPage(doc, r));
  for (const t of targets) {
    const spreadDoc = doc.xml(t.spreadPart);
    const spread = children(spreadDoc.documentElement, 'Spread')[0]!;
    const page = pageElements(spread).find((p) => attr(p, 'Self') === t.id);
    if (!page) continue;
    // Delete items that sit on this page (by center) and their stories
    for (const item of children(spread)) {
      if (item.tagName === 'Page' || item.tagName === 'FlattenerPreference' || item.tagName === 'Properties')
        continue;
      const b = itemSpreadBounds(item);
      if (b && pageForSpreadRect(pages, t.spreadId, b)?.id === t.id) {
        removeItemElement(doc, item);
      }
    }
    removeElement(page);
    if (!pageElements(spread).length) {
      // remove the whole spread
      doc.removePart(t.spreadPart);
      const ref = children(doc.root).find(
        (c) => c.tagName === 'idPkg:Spread' && attr(c, 'src') === t.spreadPart,
      );
      if (ref) removeElement(ref);
    }
  }
  updatePageCounts(doc);
  return targets.length;
}

// Small helpers shared with items.ts (kept here to avoid an import cycle).
import { anchorBounds, readPaths } from './geometry.ts';

export function itemSpreadBounds(item: Element): Rect | undefined {
  const paths = readPaths(item);
  if (!paths.length) return undefined;
  return anchorBounds(paths, parseMatrix(attr(item, 'ItemTransform')));
}

/** Removes a page item and, for text frames, the story it owned when no other frame uses it. */
export function removeItemElement(doc: IdmlDocument, item: Element): void {
  const storyIds = new Set<string>();
  const frames = [item, ...Array.from(item.getElementsByTagName('TextFrame'))];
  for (const f of frames) {
    const ps = attr(f, 'ParentStory');
    if (f.tagName === 'TextFrame' && ps) storyIds.add(ps);
  }
  removeElement(item);
  for (const storyId of storyIds) {
    if (!storyStillReferenced(doc, storyId)) {
      const part = doc.storyPartName(storyId);
      if (part) {
        doc.removePart(part);
        const ref = children(doc.root).find((c) => c.tagName === 'idPkg:Story' && attr(c, 'src') === part);
        if (ref) removeElement(ref);
      }
      const list = (attr(doc.root, 'StoryList') ?? '').split(/\s+/).filter((s) => s && s !== storyId);
      doc.root.setAttribute('StoryList', list.join(' '));
    }
  }
}

function storyStillReferenced(doc: IdmlDocument, storyId: string): boolean {
  for (const part of [...doc.spreadParts(), ...doc.masterSpreadParts()]) {
    for (const f of Array.from(doc.xml(part).getElementsByTagName('TextFrame'))) {
      if (attr(f, 'ParentStory') === storyId) return true;
    }
  }
  return false;
}

export { IDENTITY, invert };
