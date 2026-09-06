// Polygons, stars, free paths, groups and step-and-repeat.
import type { IdmlDocument } from './document.ts';
import {
  anchorBounds,
  formatMatrix,
  IDENTITY,
  multiply,
  type Path,
  type PathPoint,
  type Point,
  parseMatrix,
  type Rect,
  readPaths,
  translation,
  writePaths,
} from './geometry.ts';
import {
  applyAppearance,
  commonAttrs,
  duplicateItem,
  type FoundItem,
  findItem,
  isPageItem,
  type NewItemOptions,
  resolveContainer,
  type Target,
  TEXT_WRAP,
  translateItem,
} from './items.ts';
import { attr, children, type Element, fragment, insertAfter, removeElement } from './xml.ts';

/**
 * Regular polygon (or star when `starInset` > 0) that fills `rect`: the vertices are placed on an
 * ellipse and the result is then scaled so its bounding box is exactly `rect`, which is what a
 * designer expects when they give a position and a size.
 */
export function polygonPath(rect: Rect, sides: number, starInset = 0): Path {
  const n = Math.max(3, Math.floor(sides));
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  const inset = Math.max(0, Math.min(100, starInset)) / 100;
  const points: PathPoint[] = [];
  const count = inset > 0 ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    // start at the top like InDesign's polygon tool
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const scale = inset > 0 && i % 2 === 1 ? 1 - inset : 1;
    const p = { x: cx + Math.cos(angle) * rx * scale, y: cy + Math.sin(angle) * ry * scale };
    points.push({ anchor: p, left: p, right: p });
  }
  const raw = { open: false, points };
  const b = anchorBounds([raw]);
  if (b.width <= 0 || b.height <= 0) return raw;
  const sx = rect.width / b.width;
  const sy = rect.height / b.height;
  if (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9) return raw;
  const fit = (p: Point): Point => ({ x: rect.x + (p.x - b.x) * sx, y: rect.y + (p.y - b.y) * sy });
  return {
    open: false,
    points: points.map((p) => ({ anchor: fit(p.anchor), left: fit(p.left), right: fit(p.right) })),
  };
}

/** A path through the given points; `smooth` turns the corners into a rounded curve. */
export function freePath(points: Point[], options: { open?: boolean; smooth?: boolean } = {}): Path {
  const open = options.open !== false;
  if (points.length < 2) throw new Error('A path needs at least two points');
  if (!options.smooth) return { open, points: points.map((p) => ({ anchor: p, left: p, right: p })) };
  // Catmull-Rom style control points for a smooth curve through every point.
  const n = points.length;
  const out: PathPoint[] = points.map((p, i) => {
    const prev = points[i === 0 ? (open ? 0 : n - 1) : i - 1]!;
    const next = points[i === n - 1 ? (open ? n - 1 : 0) : i + 1]!;
    const tx = (next.x - prev.x) / 6;
    const ty = (next.y - prev.y) / 6;
    return { anchor: p, left: { x: p.x - tx, y: p.y - ty }, right: { x: p.x + tx, y: p.y + ty } };
  });
  return { open, points: out };
}

export interface NewPolygonOptions extends NewItemOptions {
  sides?: number;
  /** Star point depth in percent (0 = plain polygon, 50 = classic star). */
  starInset?: number;
}

export function createPolygon(doc: IdmlDocument, target: Target, options: NewPolygonOptions): Element {
  const path = polygonPath(
    { x: 0, y: 0, width: options.rect.width, height: options.rect.height },
    options.sides ?? 6,
    options.starInset ?? 0,
  );
  return createPathItem(doc, target, options, path);
}

export interface NewPathOptions extends Omit<NewItemOptions, 'rect'> {
  /** Points relative to the page's top-left corner. */
  points: Point[];
  open?: boolean;
  smooth?: boolean;
}

export function createFreePath(doc: IdmlDocument, target: Target, options: NewPathOptions): Element {
  const bounds = anchorBounds([freePath(options.points, options)]);
  const local = freePath(
    options.points.map((p) => ({ x: p.x - bounds.x, y: p.y - bounds.y })),
    options,
  );
  return createPathItem(doc, target, { ...options, rect: bounds }, local);
}

/** Creates a Polygon page item whose geometry is `localPath` (relative to the rect's top-left). */
function createPathItem(
  doc: IdmlDocument,
  target: Target,
  options: NewItemOptions & { graphicFrame?: boolean },
  localPath: Path,
): Element {
  const { container, origin } = resolveContainer(doc, target);
  const spreadRect: Rect = { ...options.rect, x: origin.x + options.rect.x, y: origin.y + options.rect.y };
  const graphic = options.graphicFrame === true;
  const el = fragment(
    container.ownerDocument!,
    `<Polygon ${commonAttrs(doc, options, graphic ? '[Normal Graphics Frame]' : '[None]')} ContentType="${graphic ? 'GraphicType' : 'Unassigned'}" StoryTitle="$ID/" FillColor="Swatch/None" StrokeColor="Swatch/None" StrokeWeight="0"><Properties><PathGeometry/></Properties>${TEXT_WRAP}${graphic ? '<FrameFittingOption AutoFit="false" LeftCrop="0" TopCrop="0" RightCrop="0" BottomCrop="0" FittingOnEmptyFrame="FillProportionally" FittingAlignment="CenterAnchor"/>' : ''}</Polygon>`,
  );
  const placed: Path = {
    open: localPath.open,
    points: localPath.points.map((p) => ({
      anchor: { x: p.anchor.x + spreadRect.x, y: p.anchor.y + spreadRect.y },
      left: { x: p.left.x + spreadRect.x, y: p.left.y + spreadRect.y },
      right: { x: p.right.x + spreadRect.x, y: p.right.y + spreadRect.y },
    })),
  };
  writePaths(el, [placed]);
  applyAppearance(doc, el, options, spreadRect);
  insertAfter(container, el);
  return el;
}

// ---- groups ------------------------------------------------------------------------------------

/** Wraps the given items (which must live in the same spread) in a Group, keeping their order. */
export function groupItems(doc: IdmlDocument, items: FoundItem[], name?: string): Element {
  if (items.length < 2) throw new Error('Grouping needs at least two items');
  const container = items[0]!.container;
  if (items.some((i) => i.container !== container))
    throw new Error('All items must be on the same page/spread to be grouped');
  const layer = attr(items[0]!.element, 'ItemLayer');
  const group = fragment(
    container.ownerDocument!,
    `<Group Self="${doc.newId()}" OverriddenPageItemProps="" Visible="true" Name="${name ? name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') : '$ID/'}"${layer ? ` ItemLayer="${layer}"` : ''} Locked="false" LocalDisplaySetting="Default" GradientFillStart="0 0" GradientFillLength="0" GradientFillAngle="0" GradientStrokeStart="0 0" GradientStrokeLength="0" GradientStrokeAngle="0" AppliedObjectStyle="ObjectStyle/$ID/[None]" ItemTransform="1 0 0 1 0 0"/>`,
  );
  // put the group where the topmost member was, then move the members into it (order preserved)
  const ordered = children(container)
    .filter(isPageItem)
    .filter((el) => items.some((i) => i.element === el));
  insertAfter(container, group, ordered.at(-1));
  for (const el of ordered) {
    removeElement(el);
    group.appendChild(el);
  }
  return group;
}

/** Dissolves a group, putting its items back on the spread with their absolute geometry preserved. */
export function ungroupItems(doc: IdmlDocument, group: Element): Element[] {
  const container = group.parentNode as Element | null;
  if (!container) throw new Error('The group is not attached to a spread');
  const groupTransform = parseMatrix(attr(group, 'ItemTransform'));
  const members = children(group).filter(isPageItem);
  let ref: Element = group;
  const out: Element[] = [];
  for (const el of members) {
    removeElement(el);
    // fold the group's transform into each member
    const m = multiply(groupTransform, parseMatrix(attr(el, 'ItemTransform')));
    el.setAttribute('ItemTransform', formatMatrix(m));
    if (!attr(el, 'ItemLayer') && attr(group, 'ItemLayer'))
      el.setAttribute('ItemLayer', attr(group, 'ItemLayer')!);
    insertAfter(container, el, ref);
    ref = el;
    out.push(el);
  }
  removeElement(group);
  void doc;
  return out;
}

// ---- step and repeat ---------------------------------------------------------------------------

export interface StepAndRepeatOptions {
  rows?: number;
  columns?: number;
  /** Distance between the copies' top-left corners; defaults to the item's size plus a small gap. */
  offsetX?: number;
  offsetY?: number;
  name?: string;
}

/** InDesign's Step and Repeat: a grid of copies of one item. Returns the created items. */
export function stepAndRepeat(doc: IdmlDocument, found: FoundItem, options: StepAndRepeatOptions): Element[] {
  const rows = Math.max(1, Math.floor(options.rows ?? 1));
  const cols = Math.max(1, Math.floor(options.columns ?? 1));
  if (rows * cols <= 1) throw new Error('Step and repeat needs at least two rows or columns');
  if (rows * cols > 400) throw new Error('Step and repeat is limited to 400 copies');
  const bounds = anchorBounds(readPaths(found.element), parseMatrix(attr(found.element, 'ItemTransform')));
  const dx = options.offsetX ?? bounds.width + 5;
  const dy = options.offsetY ?? bounds.height + 5;
  const created: Element[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0 && c === 0) continue;
      const clone = duplicateItem(doc, found, { x: 0, y: 0 });
      translateItem(clone, c * dx, r * dy);
      if (options.name) clone.setAttribute('Name', `${options.name} ${r * cols + c + 1}`);
      created.push(clone);
    }
  }
  return created;
}

export { findItem, IDENTITY, translation };
