// Coordinate math for IDML: affine matrices, path geometry and page/spread conversions.
import {
  appendElement,
  attr,
  children,
  type Element,
  firstChild,
  formatNumber,
  propertiesOf,
} from './xml.ts';

/** InDesign ItemTransform: "a b c d tx ty" mapping local -> parent coordinates. */
export type Matrix = readonly [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function parseMatrix(s: string | undefined | null): Matrix {
  if (!s) return IDENTITY;
  const n = s.trim().split(/\s+/).map(Number);
  if (n.length !== 6 || n.some((v) => !Number.isFinite(v))) return IDENTITY;
  return n as unknown as Matrix;
}

export function formatMatrix(m: Matrix): string {
  return m.map(formatNumber).join(' ');
}

export function apply(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Returns a∘b: apply b first, then a. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error('Matrix is not invertible');
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function translation(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

export function rotationAbout(degrees: number, center: Point): Matrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // InDesign's y axis points down; a positive angle rotates counter-clockwise on screen.
  const rot: Matrix = [cos, -sin, sin, cos, 0, 0];
  return multiply(translation(center.x, center.y), multiply(rot, translation(-center.x, -center.y)));
}

export function rotationDegrees(m: Matrix): number {
  return (Math.atan2(-m[1], m[0]) * 180) / Math.PI;
}

/** Bounding box of a set of points. */
export function bounds(points: Point[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface PathPoint {
  anchor: Point;
  left: Point;
  right: Point;
}
export interface Path {
  open: boolean;
  points: PathPoint[];
}

function parsePoint(s: string | undefined): Point {
  const [x = 0, y = 0] = (s ?? '0 0').trim().split(/\s+/).map(Number);
  return { x, y };
}

/** Reads all <GeometryPathType> paths of a page item (in the item's local coordinates). */
export function readPaths(item: Element): Path[] {
  const props = propertiesOf(item);
  const geom = props ? firstChild(props, 'PathGeometry') : undefined;
  if (!geom) return [];
  return children(geom, 'GeometryPathType').map((gp) => ({
    open: attr(gp, 'PathOpen') === 'true',
    points: children(firstChild(gp, 'PathPointArray'), 'PathPointType').map((pp) => ({
      anchor: parsePoint(attr(pp, 'Anchor')),
      left: parsePoint(attr(pp, 'LeftDirection')),
      right: parsePoint(attr(pp, 'RightDirection')),
    })),
  }));
}

/** Writes paths into the item's Properties/PathGeometry, replacing existing geometry. */
export function writePaths(item: Element, paths: Path[]): void {
  const props = propertiesOf(item, true);
  let geom = firstChild(props, 'PathGeometry');
  if (geom) {
    while (geom.firstChild) geom.removeChild(geom.firstChild);
  } else {
    geom = appendElement(props, 'PathGeometry');
  }
  for (const path of paths) {
    const gp = appendElement(geom, 'GeometryPathType');
    gp.setAttribute('PathOpen', path.open ? 'true' : 'false');
    const arr = appendElement(gp, 'PathPointArray');
    for (const p of path.points) {
      const pp = appendElement(arr, 'PathPointType');
      pp.setAttribute('Anchor', `${formatNumber(p.anchor.x)} ${formatNumber(p.anchor.y)}`);
      pp.setAttribute('LeftDirection', `${formatNumber(p.left.x)} ${formatNumber(p.left.y)}`);
      pp.setAttribute('RightDirection', `${formatNumber(p.right.x)} ${formatNumber(p.right.y)}`);
    }
  }
}

/** Rectangle path in InDesign's point order: top-left, bottom-left, bottom-right, top-right. */
export function rectPath(r: Rect): Path {
  const corner = (x: number, y: number): PathPoint => ({ anchor: { x, y }, left: { x, y }, right: { x, y } });
  return {
    open: false,
    points: [
      corner(r.x, r.y),
      corner(r.x, r.y + r.height),
      corner(r.x + r.width, r.y + r.height),
      corner(r.x + r.width, r.y),
    ],
  };
}

/** Ellipse inscribed in `r`, as 4 Bézier segments (InDesign writes ovals the same way). */
export function ellipsePath(r: Rect): Path {
  const k = 0.5522847498;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const rx = r.width / 2;
  const ry = r.height / 2;
  const pt = (ax: number, ay: number, lx: number, ly: number, rxx: number, ryy: number): PathPoint => ({
    anchor: { x: ax, y: ay },
    left: { x: lx, y: ly },
    right: { x: rxx, y: ryy },
  });
  return {
    open: false,
    points: [
      pt(cx, cy - ry, cx - rx * k, cy - ry, cx + rx * k, cy - ry), // top
      pt(cx + rx, cy, cx + rx, cy - ry * k, cx + rx, cy + ry * k), // right
      pt(cx, cy + ry, cx + rx * k, cy + ry, cx - rx * k, cy + ry), // bottom
      pt(cx - rx, cy, cx - rx, cy + ry * k, cx - rx, cy - ry * k), // left
    ],
  };
}

export function linePath(from: Point, to: Point): Path {
  const p = (pt: Point): PathPoint => ({ anchor: pt, left: pt, right: pt });
  return { open: true, points: [p(from), p(to)] };
}

/** Bounding box of a path's anchors and control points after applying `m`. */
export function pathBounds(paths: Path[], m: Matrix = IDENTITY): Rect {
  const pts: Point[] = [];
  for (const path of paths) {
    for (const p of path.points) {
      pts.push(apply(m, p.anchor));
      // control points only matter for curves; include them for a safe bounding box
      if (p.left.x !== p.anchor.x || p.left.y !== p.anchor.y) pts.push(apply(m, p.left));
      if (p.right.x !== p.anchor.x || p.right.y !== p.anchor.y) pts.push(apply(m, p.right));
    }
  }
  return bounds(pts);
}

/** Bounding box of a path's anchors only (what InDesign shows as the frame's geometric bounds). */
export function anchorBounds(paths: Path[], m: Matrix = IDENTITY): Rect {
  const pts: Point[] = [];
  for (const path of paths) for (const p of path.points) pts.push(apply(m, p.anchor));
  return bounds(pts);
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
