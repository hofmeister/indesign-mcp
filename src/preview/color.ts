// Colour conversion for previews. InDesign converts CMYK to screen colours through the document's
// CMYK profile (Coated FOGRA39 / U.S. Web Coated SWOP by default), which is far from the naive
// formula. This module approximates that conversion with a fitted model calibrated on the values
// InDesign shows for the standard swatches.
import type { IdmlDocument } from '../idml/document.ts';
import { swatchElements } from '../idml/styles.ts';
import { attr, children, type Element } from '../idml/xml.ts';

export type RGB = [number, number, number];

// Screen colours InDesign displays for pure inks and pairs with "Coated FOGRA39" (measured):
const INKS: Record<string, RGB> = {
  c: [0, 158, 224], // C=100
  m: [226, 0, 122], // M=100
  y: [255, 237, 0], // Y=100
  k: [35, 31, 32], // K=100
  cm: [46, 20, 141], // C+M
  cy: [0, 150, 64], // C+Y
  my: [227, 30, 36], // M+Y
  cmy: [35, 24, 22], // C+M+Y
};

/**
 * Multiplicative ink model: each ink attenuates the paper white toward its full-ink colour,
 * with a mild dot-gain curve. Secondary overprints are blended toward measured values so
 * mixes like C+M give a real violet instead of the naive formula's purple.
 */
export function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const gain = (v: number) => clamp01(v / 100) ** 0.92; // approximate dot gain
  const C = gain(c);
  const M = gain(m);
  const Y = gain(y);
  const K = gain(k);
  const out: RGB = [255, 255, 255];
  for (let i = 0; i < 3; i++) {
    let v = 1;
    // primary attenuation
    v *= 1 - C * (1 - INKS.c![i]! / 255);
    v *= 1 - M * (1 - INKS.m![i]! / 255);
    v *= 1 - Y * (1 - INKS.y![i]! / 255);
    // corrections for secondary overprints (measured mixes darker/more saturated than the product)
    const cm = C * M;
    const cy = C * Y;
    const my = M * Y;
    const target = (a: RGB, w: number) => (a[i]! / 255) * w;
    const naiveCm = (1 - (1 - INKS.c![i]! / 255)) * (1 - (1 - INKS.m![i]! / 255));
    const naiveCy = (1 - (1 - INKS.c![i]! / 255)) * (1 - (1 - INKS.y![i]! / 255));
    const naiveMy = (1 - (1 - INKS.m![i]! / 255)) * (1 - (1 - INKS.y![i]! / 255));
    v +=
      cm * (target(INKS.cm!, 1) - naiveCm) +
      cy * (target(INKS.cy!, 1) - naiveCy) +
      my * (target(INKS.my!, 1) - naiveMy);
    // black
    v *= 1 - K * (1 - INKS.k![i]! / 255);
    out[i] = Math.round(clamp01(v) * 255);
  }
  return out;
}

export function labToRgb(L: number, a: number, b: number): RGB {
  let y = (L + 16) / 116;
  let x = a / 500 + y;
  let z = y - b / 200;
  const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = 0.95047 * f(x);
  y = 1.0 * f(y);
  z = 1.08883 * f(z);
  const lin: RGB = [
    x * 3.2406 + y * -1.5372 + z * -0.4986,
    x * -0.9689 + y * 1.8758 + z * 0.0415,
    x * 0.0557 + y * -0.204 + z * 1.057,
  ];
  const gamma = (v: number) => (v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v);
  return lin.map((v) => Math.round(Math.max(0, Math.min(1, gamma(v))) * 255)) as RGB;
}

export function rgbToCss([r, g, b]: RGB): string {
  return `rgb(${r},${g},${b})`;
}

export interface ResolvedPaint {
  kind: 'none' | 'solid' | 'gradient';
  css?: string;
  rgb?: RGB;
  gradient?: { type: 'linear' | 'radial'; stops: { offset: number; rgb: RGB; opacity: number }[] };
}

/** Resolves a swatch reference (FillColor/StrokeColor value) to a paint. */
export class SwatchResolver {
  private cache = new Map<string, ResolvedPaint>();
  private elements = new Map<string, Element>();

  constructor(doc: IdmlDocument) {
    for (const el of swatchElements(doc)) {
      const self = attr(el, 'Self');
      if (self) this.elements.set(self, el);
    }
  }

  resolve(ref: string | undefined, tint?: number): ResolvedPaint {
    if (!ref || ref === 'Swatch/None' || ref === 'n') return { kind: 'none' };
    const key = `${ref}|${tint ?? ''}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    let paint: ResolvedPaint;
    const el = this.elements.get(ref);
    if (!el) {
      if (ref === 'Color/Paper') paint = { kind: 'solid', rgb: [255, 255, 255], css: 'rgb(255,255,255)' };
      else if (ref === 'Color/Black' || ref.endsWith('/Black'))
        paint = { kind: 'solid', rgb: INKS.k!, css: rgbToCss(INKS.k!) };
      else if (ref === 'Color/Registration') paint = { kind: 'solid', rgb: [0, 0, 0], css: 'rgb(0,0,0)' };
      else paint = { kind: 'solid', rgb: [128, 128, 128], css: 'rgb(128,128,128)' };
    } else if (el.tagName === 'Color') {
      let rgb = colorElementToRgb(el);
      if (tint !== undefined && tint >= 0 && tint < 100) rgb = applyTint(rgb, tint);
      paint = { kind: 'solid', rgb, css: rgbToCss(rgb) };
    } else if (el.tagName === 'Tint') {
      const base = this.resolve(attr(el, 'BaseColor'));
      const t = Number(attr(el, 'TintValue') ?? 100);
      const rgb = base.rgb ? applyTint(base.rgb, t) : ([200, 200, 200] as RGB);
      paint = { kind: 'solid', rgb, css: rgbToCss(rgb) };
    } else if (el.tagName === 'Gradient') {
      const stops = children(el, 'GradientStop').map((s) => {
        const stop = this.resolve(attr(s, 'StopColor'));
        return {
          offset: Number(attr(s, 'Location') ?? 0) / 100,
          rgb: stop.rgb ?? ([0, 0, 0] as RGB),
          opacity: 1,
        };
      });
      paint = {
        kind: 'gradient',
        gradient: { type: attr(el, 'Type') === 'Radial' ? 'radial' : 'linear', stops },
        rgb: stops[0]?.rgb,
        css: stops[0] ? rgbToCss(stops[0].rgb) : undefined,
      };
    } else if (el.tagName === 'MixedInk') {
      paint = { kind: 'solid', rgb: [90, 90, 90], css: 'rgb(90,90,90)' };
    } else {
      paint = { kind: 'none' };
    }
    this.cache.set(key, paint);
    return paint;
  }
}

function applyTint(rgb: RGB, tint: number): RGB {
  const t = Math.max(0, Math.min(100, tint)) / 100;
  return rgb.map((v) => Math.round(255 - (255 - v) * t)) as RGB;
}

export function colorElementToRgb(el: Element): RGB {
  const space = attr(el, 'Space');
  const values = (attr(el, 'ColorValue') ?? '').trim().split(/\s+/).map(Number);
  if (space === 'CMYK' && values.length >= 4)
    return cmykToRgb(values[0]!, values[1]!, values[2]!, values[3]!);
  if (space === 'RGB' && values.length >= 3)
    return [values[0]!, values[1]!, values[2]!].map((v) => Math.round(Math.max(0, Math.min(255, v)))) as RGB;
  if (space === 'LAB' && values.length >= 3) return labToRgb(values[0]!, values[1]!, values[2]!);
  return [128, 128, 128];
}
