import { describe, expect, test } from 'bun:test';
import {
  anchorBounds,
  apply,
  ellipsePath,
  invert,
  multiply,
  parseMatrix,
  rectPath,
  rotationAbout,
  rotationDegrees,
} from '../../src/idml/geometry.ts';
import { formatLength, resolvePageSize, toPoints } from '../../src/idml/units.ts';

describe('units', () => {
  test('parses lengths with units', () => {
    expect(toPoints('1in')).toBeCloseTo(72);
    expect(toPoints('25.4mm')).toBeCloseTo(72);
    expect(toPoints('2.54cm')).toBeCloseTo(72);
    expect(toPoints('12pt')).toBe(12);
    expect(toPoints('1p')).toBe(12);
    expect(toPoints(10)).toBeCloseTo(28.3465);
    expect(toPoints(10, 'pt')).toBe(10);
    expect(toPoints(' -5 mm ')).toBeCloseTo(-14.173);
  });
  test('rejects garbage', () => {
    expect(() => toPoints('ten mm')).toThrow();
    expect(() => toPoints('10 furlongs')).toThrow();
  });
  test('formats', () => {
    expect(formatLength(72)).toBe('25.4mm');
    expect(formatLength(0)).toBe('0mm');
    expect(formatLength(72, 'in')).toBe('1in');
  });
  test('page sizes', () => {
    expect(resolvePageSize('a4', undefined)).toEqual({ width: 595.2756, height: 841.8898 });
    expect(resolvePageSize('A4', 'landscape')).toEqual({ width: 841.8898, height: 595.2756 });
    expect(resolvePageSize(undefined, undefined, '100mm', '50mm').width).toBeCloseTo(283.465);
    expect(() => resolvePageSize('A9', undefined)).toThrow(/Unknown page size/);
  });
});

describe('geometry', () => {
  test('matrix round trip', () => {
    const m = parseMatrix('1 0 0 1 -297.5 -420.5');
    const p = apply(m, { x: 10, y: 20 });
    expect(p).toEqual({ x: -287.5, y: -400.5 });
    const back = apply(invert(m), p);
    expect(back.x).toBeCloseTo(10);
    expect(back.y).toBeCloseTo(20);
  });
  test('rotation about a point keeps the center fixed', () => {
    const c = { x: 50, y: 50 };
    const m = rotationAbout(30, c);
    const p = apply(m, c);
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(50);
    expect(rotationDegrees(m)).toBeCloseTo(30);
    expect(rotationDegrees(multiply(m, rotationAbout(-30, c)))).toBeCloseTo(0);
  });
  test('rect path order is TL, BL, BR, TR', () => {
    const p = rectPath({ x: 1, y: 2, width: 10, height: 20 });
    expect(p.points.map((pt) => [pt.anchor.x, pt.anchor.y])).toEqual([
      [1, 2],
      [1, 22],
      [11, 22],
      [11, 2],
    ]);
    expect(anchorBounds([p])).toEqual({ x: 1, y: 2, width: 10, height: 20 });
  });
  test('ellipse has four bezier points inside the rect', () => {
    const e = ellipsePath({ x: 0, y: 0, width: 100, height: 50 });
    expect(e.points).toHaveLength(4);
    expect(anchorBounds([e])).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });
});
