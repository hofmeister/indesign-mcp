// Page items: text frames, rectangles, ovals, lines. Creation, geometry, appearance, z-order.
import type { IdmlDocument } from './document.ts';
import {
  anchorBounds,
  ellipsePath,
  formatMatrix,
  IDENTITY,
  linePath,
  multiply,
  type Path,
  type Point,
  parseMatrix,
  type Rect,
  readPaths,
  rectPath,
  rotationAbout,
  rotationDegrees,
  translation,
  writePaths,
} from './geometry.ts';
import { defaultLayerId, escapeAttr, findLayer } from './layers.ts';
import {
  documentPageSize,
  findPage,
  listPages,
  type PageInfo,
  pageForSpreadRect,
  pageRectToSpread,
  removeItemElement,
} from './pages.ts';
import { BASIC_PARAGRAPH_STYLE, createStory, parseInlineMarkup, readStoryPlainText } from './stories.ts';
import { tablesIn } from './tables.ts';
import {
  allElements,
  attr,
  children,
  type Element,
  firstChild,
  fragment,
  insertAfter,
  numAttr,
  propertiesOf,
  removeElement,
  setProperty,
} from './xml.ts';

export const PAGE_ITEM_TAGS = [
  'TextFrame',
  'Rectangle',
  'Oval',
  'GraphicLine',
  'Polygon',
  'Group',
  'Button',
  'MultiStateObject',
  'FormField',
] as const;
export type ItemType = 'text' | 'rectangle' | 'ellipse' | 'line' | 'polygon' | 'group' | 'image' | 'other';

export interface ItemInfo {
  id: string;
  type: ItemType;
  tag: string;
  name: string | undefined;
  page: number | undefined;
  /** Bounds relative to the page's top-left corner (points). */
  bounds: Rect | undefined;
  spreadBounds: Rect | undefined;
  rotation: number;
  layer: string | undefined;
  storyId: string | undefined;
  text: string | undefined;
  /** Number of tables in the frame's story. A frame holding only a table has no `text`. */
  tables: number;
  imagePath: string | undefined;
  fill: string | undefined;
  stroke: string | undefined;
  strokeWeight: number;
  locked: boolean;
  onMaster: string | undefined;
  /** Which page of a multi-page master the item sits on (1-based); absent for a single-page master. */
  masterPage?: number;
  /** Spread coordinates of the top-left of the page (or master page) the item belongs to. */
  origin?: Point;
  children?: ItemInfo[];
}

export function isPageItem(el: Element): boolean {
  return (PAGE_ITEM_TAGS as readonly string[]).includes(el.tagName);
}

function classify(el: Element): ItemType {
  switch (el.tagName) {
    case 'TextFrame':
      return 'text';
    case 'Rectangle':
      return hasGraphic(el) ? 'image' : 'rectangle';
    case 'Oval':
      return hasGraphic(el) ? 'image' : 'ellipse';
    case 'GraphicLine':
      return 'line';
    case 'Polygon':
      return hasGraphic(el) ? 'image' : 'polygon';
    case 'Group':
      return 'group';
    default:
      return 'other';
  }
}

const GRAPHIC_TAGS = ['Image', 'PDF', 'EPS', 'PICT', 'WMF', 'ImportedPage', 'Graphic', 'SVG'];
export function graphicChild(el: Element): Element | undefined {
  return children(el).find((c) => GRAPHIC_TAGS.includes(c.tagName));
}
function hasGraphic(el: Element): boolean {
  return graphicChild(el) !== undefined;
}

export function linkUri(el: Element): string | undefined {
  const g = graphicChild(el);
  const link = g ? firstChild(g, 'Link') : undefined;
  return link ? attr(link, 'LinkResourceURI') : undefined;
}

/** Turns "file:/Users/me/img.jpg" or "file:///C:/x.jpg" into a filesystem path. */
export function linkUriToPath(uri: string): string {
  let p = uri.replace(/^file:\/*/, '/');
  p = decodeURIComponent(p);
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // Windows drive
  return p;
}

export function itemSpreadBounds(el: Element, parentTransform = IDENTITY): Rect | undefined {
  const m = multiply(parentTransform, parseMatrix(attr(el, 'ItemTransform')));
  if (el.tagName === 'Group') {
    const rects = children(el)
      .filter(isPageItem)
      .map((c) => itemSpreadBounds(c, m))
      .filter((r): r is Rect => !!r);
    if (!rects.length) return undefined;
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    const x2 = Math.max(...rects.map((r) => r.x + r.width));
    const y2 = Math.max(...rects.map((r) => r.y + r.height));
    return { x, y, width: x2 - x, height: y2 - y };
  }
  const paths = readPaths(el);
  if (!paths.length) return undefined;
  return anchorBounds(paths, m);
}

function displayName(el: Element): string | undefined {
  const n = attr(el, 'Name');
  if (!n || n === '$ID/') return undefined;
  return n;
}

/**
 * Where the top-left of a master's first page sits in its spread. Items are placed on a master with
 * coordinates relative to that page (see `resolveContainer`), so they have to be read back against
 * the same origin — otherwise a frame put at 18, 278 mm reports as -87, 129.5 mm.
 */
/** Turns "left"/"right"/a 1-based number into an index into a master spread's pages. */
export function masterPageIndex(page: number | 'left' | 'right' | undefined, count: number): number {
  if (page === undefined || page === 'left') return 0;
  if (page === 'right') return Math.max(0, count - 1);
  return Math.max(0, Math.floor(page) - 1);
}

/**
 * The master page an item sits on, and where that page starts. A master spread can hold several
 * pages — two for facing pages, more for a gatefold — and an item belongs to the one it is over.
 */
function masterPageOrigin(
  doc: IdmlDocument,
  masterSpreadId: string,
  bounds?: Rect,
): { origin: Point; index: number; count: number } | undefined {
  for (const ms of doc.masterSpreads()) {
    if (attr(ms, 'Self') !== masterSpreadId) continue;
    const mpages = children(ms, 'Page');
    if (!mpages.length) return undefined;
    const origins = mpages.map((p) => parseMatrix(attr(p, 'ItemTransform'))[4]);
    let index = 0;
    if (mpages.length > 1 && bounds) {
      const middle = bounds.x + bounds.width / 2;
      for (let i = 0; i < origins.length; i++) if (middle >= origins[i]!) index = i;
    }
    const m = parseMatrix(attr(mpages[index]!, 'ItemTransform'));
    return { origin: { x: m[4], y: m[5] }, index, count: mpages.length };
  }
  return undefined;
}

/**
 * The page an item belongs to, as a box in spread coordinates — a document page or the master page
 * of the spread it is on. Alignment and placement checks need the same box for both.
 */
export function pageBoxOfItem(
  doc: IdmlDocument,
  info: ItemInfo,
): { x: number; y: number; width: number; height: number; margins: PageInfo['margins'] } | undefined {
  if (info.page !== undefined) {
    const page = listPages(doc).find((p) => p.index === info.page);
    if (!page) return undefined;
    return { ...page.origin, width: page.width, height: page.height, margins: page.margins };
  }
  if (!info.onMaster || !info.origin) return undefined;
  const master = doc
    .masterSpreads()
    .find((m) => (attr(m, 'Name') ?? '') === info.onMaster || attr(m, 'Self') === info.onMaster);
  const mpage = master
    ? (children(master, 'Page')[(info.masterPage ?? 1) - 1] ?? children(master, 'Page')[0])
    : undefined;
  const size = documentPageSize(doc);
  const margin = mpage ? firstChild(mpage, 'MarginPreference') : undefined;
  return {
    x: info.origin.x,
    y: info.origin.y,
    width: size.width,
    height: size.height,
    margins: {
      top: margin ? numAttr(margin, 'Top', 0) : 0,
      bottom: margin ? numAttr(margin, 'Bottom', 0) : 0,
      left: margin ? numAttr(margin, 'Left', 0) : 0,
      right: margin ? numAttr(margin, 'Right', 0) : 0,
    },
  };
}

export function itemInfo(
  doc: IdmlDocument,
  el: Element,
  pages: PageInfo[],
  spreadId: string,
  master?: string,
  parentTransform = IDENTITY,
): ItemInfo {
  const spreadBounds = itemSpreadBounds(el, parentTransform);
  const page = spreadBounds && !master ? pageForSpreadRect(pages, spreadId, spreadBounds) : undefined;
  const onMasterPage = master ? masterPageOrigin(doc, spreadId, spreadBounds) : undefined;
  const origin = page?.origin ?? onMasterPage?.origin;
  const type = classify(el);
  const storyId = el.tagName === 'TextFrame' ? attr(el, 'ParentStory') : undefined;
  let text: string | undefined;
  let tables = 0;
  if (storyId) {
    const story = doc.story(storyId);
    if (story) {
      text = readStoryPlainText(story, { namedVariables: true });
      tables = tablesIn(story).length;
    }
  }
  const uri = linkUri(el);
  const info: ItemInfo = {
    id: attr(el, 'Self') ?? '',
    type,
    tag: el.tagName,
    name: displayName(el),
    page: page?.index,
    bounds: roundRect(
      spreadBounds && origin
        ? { ...spreadBounds, x: spreadBounds.x - origin.x, y: spreadBounds.y - origin.y }
        : spreadBounds,
    ),
    spreadBounds: roundRect(spreadBounds),
    rotation: Math.round(rotationDegrees(parseMatrix(attr(el, 'ItemTransform'))) * 100) / 100,
    layer: attr(el, 'ItemLayer'),
    storyId,
    text,
    tables,
    imagePath: uri ? linkUriToPath(uri) : undefined,
    fill: swatchDisplay(attr(el, 'FillColor')),
    stroke: swatchDisplay(attr(el, 'StrokeColor')),
    strokeWeight: Number(attr(el, 'StrokeWeight') ?? 0) || 0,
    locked: attr(el, 'Locked') === 'true',
    onMaster: master,
    masterPage: onMasterPage && onMasterPage.count > 1 ? onMasterPage.index + 1 : undefined,
    origin,
  };
  if (el.tagName === 'Group') {
    const m = multiply(parentTransform, parseMatrix(attr(el, 'ItemTransform')));
    info.children = children(el)
      .filter(isPageItem)
      .map((c) => itemInfo(doc, c, pages, spreadId, master, m));
  }
  return info;
}

function roundRect(r: Rect | undefined): Rect | undefined {
  if (!r) return undefined;
  const rd = (n: number) => Math.round(n * 10000) / 10000;
  return { x: rd(r.x), y: rd(r.y), width: rd(r.width), height: rd(r.height) };
}

export function swatchDisplay(self: string | undefined): string | undefined {
  if (!self) return undefined;
  if (self === 'Swatch/None') return 'none';
  return self.replace(/^(Color|Gradient|MixedInk|Swatch)\//, '').replace(/^\$ID\//, '');
}

export interface ListItemsOptions {
  page?: number | string;
  includeMasters?: boolean;
}

export function listItems(doc: IdmlDocument, options: ListItemsOptions = {}): ItemInfo[] {
  const pages = listPages(doc);
  const out: ItemInfo[] = [];
  const pageFilter = options.page !== undefined ? findPage(doc, options.page) : undefined;
  for (const part of doc.spreadParts()) {
    const spread = children(doc.xml(part).documentElement, 'Spread')[0];
    if (!spread) continue;
    if (pageFilter && attr(spread, 'Self') !== pageFilter.spreadId) continue;
    for (const el of children(spread)) {
      if (!isPageItem(el)) continue;
      const info = itemInfo(doc, el, pages, attr(spread, 'Self') ?? '');
      if (pageFilter && info.page !== pageFilter.index) continue;
      out.push(info);
    }
  }
  if (options.includeMasters) {
    for (const master of doc.masterSpreads()) {
      for (const el of children(master)) {
        if (!isPageItem(el)) continue;
        out.push(itemInfo(doc, el, pages, attr(master, 'Self') ?? '', attr(master, 'Name') ?? 'master'));
      }
    }
  }
  return out;
}

export interface ObscuredMasterItem {
  page: number;
  /** The master item nobody can see. */
  item: ItemInfo;
  /** The page item sitting on top of it. */
  coveredBy: ItemInfo;
}

/** An item hides what is under it when it has a fill or is a picture. */
function isOpaque(item: ItemInfo): boolean {
  if (item.type === 'image' || item.imagePath) return true;
  return !!item.fill && item.fill !== 'none';
}

function covers(outer: Rect, inner: Rect, slack = 0.5): boolean {
  return (
    outer.x <= inner.x + slack &&
    outer.y <= inner.y + slack &&
    outer.x + outer.width >= inner.x + inner.width - slack &&
    outer.y + outer.height >= inner.y + inner.height - slack
  );
}

/**
 * Master items a page item completely hides.
 *
 * InDesign always draws what a page inherits from its master *under* the page's own items, so a
 * full-page filled rectangle silently swallows the running head and folio — the layout looks right
 * in the model and wrong on the page. Bringing the master item forward is not possible; the cover
 * has to change, or the item has to come onto the page with override_master_item.
 */
export function obscuredMasterItems(doc: IdmlDocument): ObscuredMasterItem[] {
  const pages = listPages(doc);
  const nameById = new Map(doc.masterSpreads().map((m) => [attr(m, 'Self') ?? '', attr(m, 'Name') ?? '']));
  const fromMasters = listItems(doc, { includeMasters: true }).filter((i) => i.onMaster && i.bounds);
  if (!fromMasters.length) return [];
  const pageItems = listItems(doc);
  const out: ObscuredMasterItem[] = [];
  for (const page of pages) {
    const masterName = page.appliedMaster ? nameById.get(page.appliedMaster) : undefined;
    if (!masterName) continue;
    // An overridden master item has been pulled onto the page, where normal stacking applies.
    const overridden = new Set(
      (attr(doc.findBySelf(page.id)?.element as Element, 'OverrideList') ?? '').split(/\s+/).filter(Boolean),
    );
    const covers_ = pageItems.filter((i) => i.page === page.index && i.bounds && isOpaque(i));
    if (!covers_.length) continue;
    for (const inherited of fromMasters) {
      if (inherited.onMaster !== masterName || overridden.has(inherited.id)) continue;
      const cover = covers_.find((c) => covers(c.bounds!, inherited.bounds!));
      if (cover) out.push({ page: page.index, item: inherited, coveredBy: cover });
    }
  }
  return out;
}

export interface FoundItem {
  element: Element;
  info: ItemInfo;
  /** Spread or MasterSpread element containing the item. */
  container: Element;
  containerPart: string;
}

/** Resolves an item by Self id or by name (case-insensitive), optionally restricted to a page. */
export function findItem(doc: IdmlDocument, ref: string, page?: number | string): FoundItem {
  const pages = listPages(doc);
  const matches: FoundItem[] = [];
  const pageFilter = page !== undefined ? findPage(doc, page) : undefined;
  const scan = (container: Element, part: string, master?: string) => {
    const containerId = attr(container, 'Self') ?? '';
    const visit = (el: Element, parentTransform = IDENTITY) => {
      if (isPageItem(el)) {
        const info = itemInfo(doc, el, pages, containerId, master, parentTransform);
        const byId = info.id === ref;
        const byName = (info.name ?? '').toLowerCase() === ref.toLowerCase();
        if ((byId || byName) && (!pageFilter || info.page === pageFilter.index || byId)) {
          matches.push({ element: el, info, container, containerPart: part });
        }
        if (el.tagName === 'Group') {
          const m = multiply(parentTransform, parseMatrix(attr(el, 'ItemTransform')));
          for (const c of children(el)) visit(c, m);
        }
      }
    };
    for (const el of children(container)) visit(el);
  };
  for (const part of doc.spreadParts()) {
    const spread = children(doc.xml(part).documentElement, 'Spread')[0];
    if (spread) scan(spread, part);
  }
  for (const part of doc.masterSpreadParts()) {
    const ms = children(doc.xml(part).documentElement, 'MasterSpread')[0];
    if (ms) scan(ms, part, attr(ms, 'Name') ?? 'master');
  }
  if (!matches.length) {
    // items anchored in text live inside their story, not on the spread
    for (const part of doc.storyParts()) {
      const story = children(doc.xml(part).documentElement, 'Story')[0];
      if (!story) continue;
      for (const el of allElements(story)) {
        if (!isPageItem(el)) continue;
        const info = itemInfo(doc, el, pages, attr(story, 'Self') ?? '');
        if (info.id === ref || (info.name ?? '').toLowerCase() === ref.toLowerCase())
          matches.push({ element: el, info, container: story, containerPart: part });
      }
    }
  }
  if (!matches.length) {
    throw new Error(
      `No item named or identified "${ref}"${pageFilter ? ` on page ${pageFilter.index}` : ''}. Use describe_document or list_items to see item names and ids.`,
    );
  }
  if (matches.length > 1) {
    const exact = matches.filter((m) => m.info.id === ref);
    if (exact.length === 1) return exact[0]!;
    const where = matches
      .map(
        (m) =>
          `${m.info.id} (${m.info.type}${m.info.page ? `, page ${m.info.page}` : m.info.onMaster ? `, master ${m.info.onMaster}` : ''})`,
      )
      .join('; ');
    throw new Error(`"${ref}" matches ${matches.length} items: ${where}. Use the id or add the page number.`);
  }
  return matches[0]!;
}

// ---- creation ------------------------------------------------------------------------------

export type Target =
  | { page: number | string }
  /** `masterPage` is 1-based within the master spread; "left" is its first page, "right" its last. */
  | { master: string; masterPage?: number | 'left' | 'right' };

export interface NewItemOptions {
  /** Page-relative rectangle in points. */
  rect: Rect;
  name?: string;
  layer?: string;
  fill?: string;
  stroke?: string;
  strokeWeight?: number;
  rotation?: number;
}

export function resolveContainer(
  doc: IdmlDocument,
  target: Target,
): { container: Element; part: string; origin: Point; page?: PageInfo } {
  if ('master' in target) {
    for (const part of doc.masterSpreadParts()) {
      const ms = children(doc.xml(part).documentElement, 'MasterSpread')[0];
      if (!ms) continue;
      const name = attr(ms, 'Name') ?? '';
      const prefix = attr(ms, 'NamePrefix') ?? '';
      if (
        [attr(ms, 'Self'), name, prefix, attr(ms, 'BaseName')].some(
          (n) => (n ?? '').toLowerCase() === target.master.toLowerCase(),
        )
      ) {
        // Coordinates are relative to the master page being placed on: its first page unless
        // another one was asked for.
        const mpages = children(ms, 'Page');
        const index = masterPageIndex(target.masterPage, mpages.length);
        if (index >= mpages.length)
          throw new Error(
            `Master "${target.master}" has ${mpages.length} page(s), so there is no page ${index + 1}.`,
          );
        const page = mpages[index];
        const pi = page ? parseMatrix(attr(page, 'ItemTransform')) : IDENTITY;
        return { container: ms, part, origin: { x: pi[4], y: pi[5] } };
      }
    }
    const available = doc
      .masterSpreads()
      .map((m) => attr(m, 'Name'))
      .filter(Boolean)
      .join(', ');
    throw new Error(`Master page "${target.master}" not found. Available: ${available || 'none'}`);
  }
  const page = findPage(doc, target.page);
  const spread = children(doc.xml(page.spreadPart).documentElement, 'Spread')[0]!;
  return { container: spread, part: page.spreadPart, origin: page.origin, page };
}

function resolveLayer(doc: IdmlDocument, layer: string | undefined): string {
  if (!layer) return defaultLayerId(doc);
  const el = findLayer(doc, layer);
  if (!el) throw new Error(`Layer "${layer}" not found`);
  return attr(el, 'Self')!;
}

export function commonAttrs(doc: IdmlDocument, options: NewItemOptions, objectStyle: string): string {
  return `Self="${doc.newId()}" OverriddenPageItemProps="" Visible="true" Name="${options.name ? escapeAttr(options.name) : '$ID/'}" ItemLayer="${resolveLayer(doc, options.layer)}" Locked="false" LocalDisplaySetting="Default" GradientFillStart="0 0" GradientFillLength="0" GradientFillAngle="0" GradientStrokeStart="0 0" GradientStrokeLength="0" GradientStrokeAngle="0" AppliedObjectStyle="ObjectStyle/$ID/${objectStyle}" ItemTransform="1 0 0 1 0 0"`;
}

export const TEXT_WRAP = `<TextWrapPreference Inverse="false" ApplyToMasterPageOnly="false" TextWrapSide="BothSides" TextWrapMode="None"><Properties><TextWrapOffset Top="0" Left="0" Bottom="0" Right="0"/></Properties></TextWrapPreference>`;

function appendItem(container: Element, el: Element): void {
  // Page items follow the Page elements; append at the end (top of z-order).
  insertAfter(container, el);
}

export function applyAppearance(
  doc: IdmlDocument,
  el: Element,
  options: NewItemOptions,
  spreadRect: Rect,
): void {
  if (options.fill !== undefined) setFill(doc, el, options.fill);
  if (options.stroke !== undefined || options.strokeWeight !== undefined) {
    setStroke(doc, el, { swatch: options.stroke, weight: options.strokeWeight });
  }
  if (options.rotation) {
    const c = { x: spreadRect.x + spreadRect.width / 2, y: spreadRect.y + spreadRect.height / 2 };
    el.setAttribute('ItemTransform', formatMatrix(rotationAbout(options.rotation, c)));
  }
}

export interface NewTextFrameOptions extends NewItemOptions {
  text?: string;
  /** Paragraphs with their own styles, instead of `text`. */
  paragraphs?: { text: string; style?: string }[];
  paragraphStyle?: string;
  columns?: number;
  gutter?: number;
  inset?: number | [number, number, number, number];
  verticalJustification?: 'top' | 'center' | 'bottom' | 'justify';
  autoSize?: 'off' | 'height' | 'width' | 'both';
}

export function createTextFrame(doc: IdmlDocument, target: Target, options: NewTextFrameOptions): Element {
  const { container, origin } = resolveContainer(doc, target);
  const spreadRect = { ...options.rect, x: origin.x + options.rect.x, y: origin.y + options.rect.y };
  const story = createStory(doc, {
    text: options.paragraphs?.length
      ? options.paragraphs.map((p) => ({
          style: p.style ?? options.paragraphStyle ?? BASIC_PARAGRAPH_STYLE,
          runs: parseInlineMarkup(p.text),
        }))
      : (options.text ?? ''),
    paragraphStyle: options.paragraphStyle,
  });
  const storyId = attr(story, 'Self')!;
  const el = fragment(
    container.ownerDocument!,
    `<TextFrame ${commonAttrs(doc, options, '[Normal Text Frame]')} ParentStory="${storyId}" PreviousTextFrame="n" NextTextFrame="n" ContentType="TextType" StrokeWeight="0" StrokeColor="Swatch/None" FillColor="Swatch/None"><Properties><PathGeometry/></Properties><TextFramePreference TextColumnCount="1" TextColumnGutter="12" TextColumnFixedWidth="${spreadRect.width}" UseFixedColumnWidth="false" FirstBaselineOffset="AscentOffset" MinimumFirstBaselineOffset="0" VerticalJustification="TopAlign" VerticalThreshold="0" IgnoreWrap="false" VerticalBalanceColumns="false" AutoSizingType="Off" AutoSizingReferencePoint="TopLeftPoint" UseMinimumHeightForAutoSizing="false" MinimumHeightForAutoSizing="0" UseMinimumWidthForAutoSizing="false" MinimumWidthForAutoSizing="0" UseNoLineBreaksForAutoSizing="false"><Properties><InsetSpacing type="list"><ListItem type="unit">0</ListItem><ListItem type="unit">0</ListItem><ListItem type="unit">0</ListItem><ListItem type="unit">0</ListItem></InsetSpacing></Properties></TextFramePreference>${TEXT_WRAP}</TextFrame>`,
  );
  writePaths(el, [rectPath(spreadRect)]);
  setTextFrameOptions(el, options);
  applyAppearance(doc, el, options, spreadRect);
  appendItem(container, el);
  return el;
}

export function setTextFrameOptions(
  el: Element,
  o: Pick<NewTextFrameOptions, 'columns' | 'gutter' | 'inset' | 'verticalJustification' | 'autoSize'>,
): void {
  const pref = firstChild(el, 'TextFramePreference');
  if (!pref) return;
  if (o.columns !== undefined)
    pref.setAttribute('TextColumnCount', String(Math.max(1, Math.floor(o.columns))));
  if (o.gutter !== undefined) pref.setAttribute('TextColumnGutter', String(o.gutter));
  if (o.verticalJustification) {
    pref.setAttribute(
      'VerticalJustification',
      { top: 'TopAlign', center: 'CenterAlign', bottom: 'BottomAlign', justify: 'JustifyAlign' }[
        o.verticalJustification
      ],
    );
  }
  if (o.autoSize) {
    pref.setAttribute(
      'AutoSizingType',
      { off: 'Off', height: 'HeightOnly', width: 'WidthOnly', both: 'HeightAndWidth' }[o.autoSize],
    );
    if (o.autoSize !== 'off') pref.setAttribute('AutoSizingReferencePoint', 'TopLeftPoint');
  }
  if (o.inset !== undefined) {
    const [t, l, b, r] = typeof o.inset === 'number' ? [o.inset, o.inset, o.inset, o.inset] : o.inset;
    const props = propertiesOf(pref, true);
    const existing = firstChild(props, 'InsetSpacing');
    if (existing) removeElement(existing);
    const spacing = fragment(
      el.ownerDocument!,
      `<InsetSpacing type="list"><ListItem type="unit">${t}</ListItem><ListItem type="unit">${l}</ListItem><ListItem type="unit">${b}</ListItem><ListItem type="unit">${r}</ListItem></InsetSpacing>`,
    );
    props.appendChild(spacing);
  }
}

export function createRectangle(
  doc: IdmlDocument,
  target: Target,
  options: NewItemOptions & { graphicFrame?: boolean },
): Element {
  return createShape(doc, target, options, 'Rectangle');
}

export function createOval(
  doc: IdmlDocument,
  target: Target,
  options: NewItemOptions & { graphicFrame?: boolean },
): Element {
  return createShape(doc, target, options, 'Oval');
}

function createShape(
  doc: IdmlDocument,
  target: Target,
  options: NewItemOptions & { graphicFrame?: boolean },
  tag: 'Rectangle' | 'Oval',
): Element {
  const { container, origin } = resolveContainer(doc, target);
  const spreadRect = { ...options.rect, x: origin.x + options.rect.x, y: origin.y + options.rect.y };
  const graphic = options.graphicFrame === true;
  const el = fragment(
    container.ownerDocument!,
    `<${tag} ${commonAttrs(doc, options, graphic ? '[Normal Graphics Frame]' : '[None]')} ContentType="${graphic ? 'GraphicType' : 'Unassigned'}" StoryTitle="$ID/" FillColor="${graphic || options.fill === undefined ? 'Swatch/None' : 'Swatch/None'}" StrokeColor="Swatch/None" StrokeWeight="0"><Properties><PathGeometry/></Properties>${TEXT_WRAP}${graphic ? '<FrameFittingOption AutoFit="false" LeftCrop="0" TopCrop="0" RightCrop="0" BottomCrop="0" FittingOnEmptyFrame="FillProportionally" FittingAlignment="CenterAnchor"/>' : ''}</${tag}>`,
  );
  writePaths(el, [tag === 'Oval' ? ellipsePath(spreadRect) : rectPath(spreadRect)]);
  if (!graphic && options.fill === undefined) setFill(doc, el, 'Black');
  applyAppearance(doc, el, options, spreadRect);
  appendItem(container, el);
  return el;
}

export function createLine(
  doc: IdmlDocument,
  target: Target,
  options: { from: Point; to: Point; name?: string; layer?: string; stroke?: string; strokeWeight?: number },
): Element {
  const { container, origin } = resolveContainer(doc, target);
  const from = { x: origin.x + options.from.x, y: origin.y + options.from.y };
  const to = { x: origin.x + options.to.x, y: origin.y + options.to.y };
  const rect: Rect = {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
  const el = fragment(
    container.ownerDocument!,
    `<GraphicLine ${commonAttrs(doc, { rect, name: options.name, layer: options.layer }, '[None]')} ContentType="Unassigned" FillColor="Swatch/None" StrokeColor="Color/Black" StrokeWeight="${options.strokeWeight ?? 1}"><Properties><PathGeometry/></Properties>${TEXT_WRAP}</GraphicLine>`,
  );
  writePaths(el, [linePath(from, to)]);
  if (options.stroke !== undefined || options.strokeWeight !== undefined)
    setStroke(doc, el, { swatch: options.stroke, weight: options.strokeWeight ?? 1 });
  appendItem(container, el);
  return el;
}

// ---- appearance ----------------------------------------------------------------------------

import { resolveSwatch } from './styles.ts';

export function setFill(doc: IdmlDocument, el: Element, swatch: string, tint?: number): void {
  el.setAttribute('FillColor', resolveSwatch(doc, swatch));
  if (tint !== undefined) el.setAttribute('FillTint', String(tint));
}

export function setStroke(
  doc: IdmlDocument,
  el: Element,
  o: {
    swatch?: string;
    weight?: number;
    type?: string;
    tint?: number;
    alignment?: 'center' | 'inside' | 'outside';
  },
): void {
  if (o.swatch !== undefined) el.setAttribute('StrokeColor', resolveSwatch(doc, o.swatch));
  if (o.weight !== undefined) {
    el.setAttribute('StrokeWeight', String(o.weight));
    if (
      o.weight > 0 &&
      (attr(el, 'StrokeColor') === undefined || attr(el, 'StrokeColor') === 'Swatch/None') &&
      o.swatch === undefined
    ) {
      el.setAttribute('StrokeColor', 'Color/Black');
    }
  }
  if (o.type) {
    const known: Record<string, string> = {
      solid: 'Solid',
      dashed: 'Dashed',
      dotted: 'Dotted',
      'thick-thin': 'ThickThin',
      'thin-thick': 'ThinThick',
      wavy: 'Wavy',
      'white-diamond': 'White Diamond',
      'left-slant-hash': 'Left Slant Hash',
    };
    const name = known[o.type.toLowerCase()] ?? o.type;
    el.setAttribute('StrokeType', `StrokeStyle/$ID/${name}`);
  }
  if (o.tint !== undefined) el.setAttribute('StrokeTint', String(o.tint));
  if (o.alignment)
    el.setAttribute(
      'StrokeAlignment',
      { center: 'CenterAlignment', inside: 'InsideAlignment', outside: 'OutsideAlignment' }[o.alignment],
    );
}

export function setCornerRadius(
  el: Element,
  radius: number,
  shape: 'rounded' | 'inverse-rounded' | 'bevel' | 'inset' | 'fancy' | 'none' = 'rounded',
): void {
  const option = {
    rounded: 'RoundedCorner',
    'inverse-rounded': 'InverseRoundedCorner',
    bevel: 'BevelCorner',
    inset: 'InsetCorner',
    fancy: 'FancyCorner',
    none: 'None',
  }[shape];
  for (const corner of ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight']) {
    el.setAttribute(`${corner}CornerOption`, option);
    el.setAttribute(`${corner}CornerRadius`, String(radius));
  }
}

export function setOpacity(el: Element, opacity: number, blendMode?: string): void {
  const doc = el.ownerDocument!;
  let ts = firstChild(el, 'TransparencySetting');
  if (!ts) {
    ts = fragment(
      doc,
      `<TransparencySetting><BlendingSetting Opacity="100" BlendMode="Normal"/></TransparencySetting>`,
    );
    // TransparencySetting goes after TextWrapPreference by convention; appending is accepted
    el.appendChild(ts);
  }
  let bs = firstChild(ts, 'BlendingSetting');
  if (!bs)
    bs = ts.appendChild(fragment(doc, `<BlendingSetting Opacity="100" BlendMode="Normal"/>`)) as Element;
  bs.setAttribute('Opacity', String(Math.max(0, Math.min(100, opacity))));
  if (blendMode) bs.setAttribute('BlendMode', blendMode);
}

// ---- geometry edits ------------------------------------------------------------------------

/** Moves the item so its bounds' top-left lands on `to` (spread coordinates). */
export function moveItemTo(el: Element, to: Point, parentTransform = IDENTITY): void {
  const b = itemSpreadBounds(el, parentTransform);
  if (!b) return;
  translateItem(el, to.x - b.x, to.y - b.y);
}

export function translateItem(el: Element, dx: number, dy: number): void {
  const m = parseMatrix(attr(el, 'ItemTransform'));
  el.setAttribute('ItemTransform', formatMatrix(multiply(translation(dx, dy), m)));
}

/** Resizes the item's path so its bounding box becomes `width` x `height`, keeping the top-left fixed. */
export function resizeItem(el: Element, width: number | undefined, height: number | undefined): void {
  const paths = readPaths(el);
  if (!paths.length) return;
  const b = anchorBounds(paths);
  const sx = width !== undefined && b.width > 0 ? width / b.width : 1;
  const sy = height !== undefined && b.height > 0 ? height / b.height : 1;
  const scaled: Path[] = paths.map((p) => ({
    open: p.open,
    points: p.points.map((pt) => ({
      anchor: { x: b.x + (pt.anchor.x - b.x) * sx, y: b.y + (pt.anchor.y - b.y) * sy },
      left: { x: b.x + (pt.left.x - b.x) * sx, y: b.y + (pt.left.y - b.y) * sy },
      right: { x: b.x + (pt.right.x - b.x) * sx, y: b.y + (pt.right.y - b.y) * sy },
    })),
  }));
  writePaths(el, scaled);
  const pref = firstChild(el, 'TextFramePreference');
  if (pref && width !== undefined) pref.setAttribute('TextColumnFixedWidth', String(width));
}

/** Sets an absolute rotation (degrees, counter-clockwise) around the item's center. */
export function rotateItem(el: Element, degrees: number): void {
  const paths = readPaths(el);
  const m = parseMatrix(attr(el, 'ItemTransform'));
  const b = anchorBounds(paths);
  const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const current = rotationDegrees(m);
  const delta = degrees - current;
  const c = { x: m[0] * center.x + m[2] * center.y + m[4], y: m[1] * center.x + m[3] * center.y + m[5] };
  el.setAttribute('ItemTransform', formatMatrix(multiply(rotationAbout(delta, c), m)));
}

export function deleteItem(doc: IdmlDocument, el: Element): void {
  removeItemElement(doc, el);
}

export function renameItem(el: Element, name: string | undefined): void {
  el.setAttribute('Name', name ? name : '$ID/');
}

export type ArrangeAction = 'front' | 'back' | 'forward' | 'backward';

export function arrangeItem(el: Element, action: ArrangeAction): void {
  const parent = el.parentNode as Element | null;
  if (!parent) return;
  const siblings = children(parent).filter(isPageItem);
  const idx = siblings.indexOf(el);
  if (idx < 0) return;
  removeElement(el);
  const remaining = siblings.filter((s) => s !== el);
  let ref: Element | undefined;
  switch (action) {
    case 'front':
      ref = remaining.at(-1);
      break;
    case 'back':
      ref = undefined;
      break;
    case 'forward':
      ref = remaining[Math.min(idx, remaining.length - 1)];
      break;
    case 'backward':
      ref = idx >= 2 ? remaining[idx - 2] : undefined;
      break;
  }
  if (ref) insertAfter(parent, el, ref);
  else if (action === 'back' || action === 'backward') {
    const first = remaining[0];
    const before = first ?? children(parent).at(-1);
    if (first) {
      // insert before the first page item
      const pages = children(parent, 'Page');
      insertAfter(parent, el, pages.at(-1) ?? firstChild(parent, 'FlattenerPreference'));
    } else if (before) insertAfter(parent, el, before);
    else parent.appendChild(el);
  } else insertAfter(parent, el);
}

export function duplicateItem(
  doc: IdmlDocument,
  found: FoundItem,
  offset: Point = { x: 14.173, y: 14.173 },
): Element {
  const clone = found.element.cloneNode(true) as Element;
  // fresh ids for the clone and all descendants with Self; copy stories
  const withSelf = [clone, ...Array.from(clone.getElementsByTagName('*'))].filter((e) =>
    (e as Element).hasAttribute?.('Self'),
  ) as Element[];
  for (const e of withSelf) e.setAttribute('Self', doc.newId());
  const frames = [clone, ...Array.from(clone.getElementsByTagName('TextFrame'))].filter(
    (e) => e.tagName === 'TextFrame',
  );
  for (const f of frames) {
    const storyId = attr(f, 'ParentStory');
    if (!storyId) continue;
    const story = doc.story(storyId);
    if (!story) continue;
    const copy = createStory(doc, { text: '' });
    // replace the copy's content with the original story's children
    while (copy.firstChild) copy.removeChild(copy.firstChild);
    for (const c of Array.from(story.childNodes)) copy.appendChild(copy.ownerDocument!.importNode(c, true));
    const newSelf = attr(copy, 'Self')!;
    // the imported Story kept its own Self attribute children? no: Self is on the element we created
    f.setAttribute('ParentStory', newSelf);
    f.setAttribute('PreviousTextFrame', 'n');
    f.setAttribute('NextTextFrame', 'n');
  }
  translateItem(clone, offset.x, offset.y);
  insertAfter(found.container, clone, found.element);
  return clone;
}

export { anchorBounds, pageRectToSpread, readPaths, setProperty };
