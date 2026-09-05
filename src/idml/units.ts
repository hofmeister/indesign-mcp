// Length parsing and formatting. Everything inside the IDML model is in PostScript points.
export type Unit = 'mm' | 'cm' | 'in' | 'pt' | 'px' | 'p';

export const POINTS_PER: Record<Unit, number> = {
  pt: 1,
  px: 1,
  mm: 72 / 25.4,
  cm: 72 / 2.54,
  in: 72,
  p: 12, // picas
};

export type LengthInput = number | string;

/**
 * Parses "10mm", "0.5 in", "12pt", "2cm", "3p" (picas) or a bare number (in `defaultUnit`).
 * Returns points.
 */
export function toPoints(value: LengthInput, defaultUnit: Unit = 'mm'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid length: ${value}`);
    return value * POINTS_PER[defaultUnit];
  }
  const m = /^\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*(mm|cm|in|pt|px|p|")?\s*$/i.exec(value);
  if (!m)
    throw new Error(
      `Invalid length "${value}". Use e.g. "10mm", "0.5in", "12pt" or a number (${defaultUnit}).`,
    );
  const n = Number(m[1]);
  const unit =
    (m[2]?.toLowerCase() === '"' ? 'in' : (m[2]?.toLowerCase() as Unit | undefined)) ?? defaultUnit;
  return n * POINTS_PER[unit];
}

export function fromPoints(points: number, unit: Unit = 'mm'): number {
  return points / POINTS_PER[unit];
}

export function formatLength(points: number, unit: Unit = 'mm', decimals = 2): string {
  const v = fromPoints(points, unit);
  const rounded = Number(v.toFixed(decimals));
  return `${rounded === 0 ? 0 : rounded}${unit}`;
}

export const PAGE_SIZES: Record<string, { width: number; height: number }> = {
  // in points, portrait
  A3: { width: 841.8898, height: 1190.5512 },
  A4: { width: 595.2756, height: 841.8898 },
  A5: { width: 419.5276, height: 595.2756 },
  A6: { width: 297.6378, height: 419.5276 },
  B5: { width: 498.8976, height: 708.6614 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
  Tabloid: { width: 792, height: 1224 },
  'US Business Card': { width: 252, height: 144 },
  'EU Business Card': { width: 241.8898, height: 155.9055 },
  'Instagram Post': { width: 1080, height: 1080 },
  'Instagram Story': { width: 1080, height: 1920 },
  'Facebook Post': { width: 1200, height: 630 },
};

export function resolvePageSize(
  preset: string | undefined,
  orientation: 'portrait' | 'landscape' | undefined,
  width?: LengthInput,
  height?: LengthInput,
  defaultUnit: Unit = 'mm',
): { width: number; height: number } {
  let size: { width: number; height: number };
  if (width !== undefined && height !== undefined) {
    size = { width: toPoints(width, defaultUnit), height: toPoints(height, defaultUnit) };
  } else {
    const key = Object.keys(PAGE_SIZES).find((k) => k.toLowerCase() === (preset ?? 'A4').toLowerCase());
    if (!key) {
      throw new Error(`Unknown page size "${preset}". Known presets: ${Object.keys(PAGE_SIZES).join(', ')}`);
    }
    size = { ...PAGE_SIZES[key]! };
  }
  if (orientation === 'landscape' && size.height > size.width)
    size = { width: size.height, height: size.width };
  if (orientation === 'portrait' && size.width > size.height)
    size = { width: size.height, height: size.width };
  return size;
}
