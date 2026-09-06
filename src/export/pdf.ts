// A small vector PDF writer plus a converter for the SVG the preview renderer produces.
// Text is drawn as glyph outlines (the renderer already emits outlines), so the PDF looks right
// on any computer without embedding fonts — it just cannot be selected or searched.
import { zlibSync } from 'fflate';
import { decode as decodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { allElements, children, type Element, parseXml } from '../idml/xml.ts';

// ---- low-level PDF -------------------------------------------------------------------------

type Obj = { id: number; body: Uint8Array };

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'latin1'));

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export class PdfWriter {
  private objects: Obj[] = [];

  alloc(): number {
    this.objects.push({ id: this.objects.length + 1, body: new Uint8Array() });
    return this.objects.length;
  }

  set(id: number, body: string | Uint8Array): number {
    this.objects[id - 1]!.body = typeof body === 'string' ? enc(body) : body;
    return id;
  }

  add(body: string | Uint8Array): number {
    return this.set(this.alloc(), body);
  }

  /** A stream object; the data is deflated unless `raw` says it is already encoded. */
  addStream(dict: string, data: Uint8Array, options: { alreadyEncoded?: boolean } = {}): number {
    const bytes = options.alreadyEncoded ? data : zlibSync(data, { level: 6 });
    const extra = options.alreadyEncoded ? '' : ' /Filter /FlateDecode';
    return this.add(
      concat([enc(`<< ${dict}${extra} /Length ${bytes.length} >>\nstream\n`), bytes, enc('\nendstream')]),
    );
  }

  build(catalogId: number, info: Record<string, string> = {}): Uint8Array {
    const header = enc('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
    const chunks: Uint8Array[] = [header];
    const offsets: number[] = [];
    let position = header.length;
    for (const obj of this.objects) {
      offsets.push(position);
      const piece = concat([enc(`${obj.id} 0 obj\n`), obj.body, enc('\nendobj\n')]);
      chunks.push(piece);
      position += piece.length;
    }
    const infoEntries = Object.entries(info)
      .map(([k, v]) => `/${k} (${v.replace(/([()\\])/g, '\\$1')})`)
      .join(' ');
    const infoId = infoEntries ? this.objects.length + 1 : 0;
    if (infoId) {
      offsets.push(position);
      const piece = concat([enc(`${infoId} 0 obj\n<< ${infoEntries} >>\nendobj\n`)]);
      chunks.push(piece);
      position += piece.length;
    }
    const count = offsets.length + 1;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${count} /Root ${catalogId} 0 R${infoId ? ` /Info ${infoId} 0 R` : ''} >>\nstartxref\n${position}\n%%EOF\n`;
    chunks.push(enc(xref));
    return concat(chunks);
  }
}

// ---- SVG path data -------------------------------------------------------------------------

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.abs(n) < 1e-6 ? '0' : String(Math.round(n * 1000) / 1000);
}

/** Converts an SVG `d` attribute into PDF path operators (same coordinate space). */
export function pathDataToPdf(d: string): string {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const ops: string[] = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let prevCtrl: [number, number] | undefined;
  let prevQCtrl: [number, number] | undefined;
  let cmd = '';
  const num = () => Number(tokens[i++]);
  const move = (x: number, y: number) => {
    ops.push(`${fmt(x)} ${fmt(y)} m`);
    cx = sx = x;
    cy = sy = y;
  };
  const line = (x: number, y: number) => {
    ops.push(`${fmt(x)} ${fmt(y)} l`);
    cx = x;
    cy = y;
  };
  const curve = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    ops.push(`${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(x)} ${fmt(y)} c`);
    cx = x;
    cy = y;
  };
  const quad = (qx: number, qy: number, x: number, y: number) => {
    curve(
      cx + (2 / 3) * (qx - cx),
      cy + (2 / 3) * (qy - cy),
      x + (2 / 3) * (qx - x),
      y + (2 / 3) * (qy - y),
      x,
      y,
    );
    prevQCtrl = [qx, qy];
  };
  const arc = (rx: number, ry: number, rot: number, large: number, sweep: number, x: number, y: number) => {
    // Endpoint → centre parameterisation (SVG implementation notes F.6).
    if (!rx || !ry) return line(x, y);
    const phi = (rot * Math.PI) / 180;
    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi);
    const dx2 = (cx - x) / 2;
    const dy2 = (cy - y) / 2;
    const x1p = cosP * dx2 + sinP * dy2;
    const y1p = -sinP * dx2 + cosP * dy2;
    let rxa = Math.abs(rx);
    let rya = Math.abs(ry);
    const lambda = (x1p * x1p) / (rxa * rxa) + (y1p * y1p) / (rya * rya);
    if (lambda > 1) {
      rxa *= Math.sqrt(lambda);
      rya *= Math.sqrt(lambda);
    }
    const sign = large === sweep ? -1 : 1;
    const numer = rxa * rxa * rya * rya - rxa * rxa * y1p * y1p - rya * rya * x1p * x1p;
    const denom = rxa * rxa * y1p * y1p + rya * rya * x1p * x1p;
    const co = sign * Math.sqrt(Math.max(0, numer / denom));
    const cxp = (co * rxa * y1p) / rya;
    const cyp = (-co * rya * x1p) / rxa;
    const centreX = cosP * cxp - sinP * cyp + (cx + x) / 2;
    const centreY = sinP * cxp + cosP * cyp + (cy + y) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number) => {
      const dot = ux * vx + uy * vy;
      const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      const a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
      return ux * vy - uy * vx < 0 ? -a : a;
    };
    const theta = angle(1, 0, (x1p - cxp) / rxa, (y1p - cyp) / rya);
    let delta = angle((x1p - cxp) / rxa, (y1p - cyp) / rya, (-x1p - cxp) / rxa, (-y1p - cyp) / rya);
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    if (sweep && delta < 0) delta += 2 * Math.PI;
    const segments = Math.ceil(Math.abs(delta / (Math.PI / 2)));
    const step = delta / segments;
    const k = (4 / 3) * Math.tan(step / 4);
    let t = theta;
    for (let s = 0; s < segments; s++) {
      const cos1 = Math.cos(t);
      const sin1 = Math.sin(t);
      const t2 = t + step;
      const cos2 = Math.cos(t2);
      const sin2 = Math.sin(t2);
      const p = (ax: number, ay: number): [number, number] => [
        centreX + cosP * rxa * ax - sinP * rya * ay,
        centreY + sinP * rxa * ax + cosP * rya * ay,
      ];
      const [x1, y1] = p(cos1 - k * sin1, sin1 + k * cos1);
      const [x2, y2] = p(cos2 + k * sin2, sin2 - k * cos2);
      const [xe, ye] = p(cos2, sin2);
      curve(x1, y1, x2, y2, xe, ye);
      t = t2;
    }
  };

  while (i < tokens.length) {
    const token = tokens[i]!;
    if (/[A-Za-z]/.test(token)) {
      cmd = token;
      i++;
    } else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    switch (cmd) {
      case 'M':
        move(num(), num());
        break;
      case 'm':
        move(cx + num(), cy + num());
        break;
      case 'L':
        line(num(), num());
        break;
      case 'l':
        line(cx + num(), cy + num());
        break;
      case 'H':
        line(num(), cy);
        break;
      case 'h':
        line(cx + num(), cy);
        break;
      case 'V':
        line(cx, num());
        break;
      case 'v':
        line(cx, cy + num());
        break;
      case 'C': {
        const x1 = num();
        const y1 = num();
        const x2 = num();
        const y2 = num();
        curve(x1, y1, x2, y2, num(), num());
        prevCtrl = [x2, y2];
        break;
      }
      case 'c': {
        const x1 = cx + num();
        const y1 = cy + num();
        const x2 = cx + num();
        const y2 = cy + num();
        const x = cx + num();
        const y = cy + num();
        curve(x1, y1, x2, y2, x, y);
        prevCtrl = [x2, y2];
        break;
      }
      case 'S':
      case 's': {
        const rel = cmd === 's';
        const rx = prevCtrl ? 2 * cx - prevCtrl[0] : cx;
        const ry = prevCtrl ? 2 * cy - prevCtrl[1] : cy;
        const x2 = (rel ? cx : 0) + num();
        const y2 = (rel ? cy : 0) + num();
        const x = (rel ? cx : 0) + num();
        const y = (rel ? cy : 0) + num();
        curve(rx, ry, x2, y2, x, y);
        prevCtrl = [x2, y2];
        break;
      }
      case 'Q':
      case 'q': {
        const rel = cmd === 'q';
        const qx = (rel ? cx : 0) + num();
        const qy = (rel ? cy : 0) + num();
        quad(qx, qy, (rel ? cx : 0) + num(), (rel ? cy : 0) + num());
        break;
      }
      case 'T':
      case 't': {
        const rel = cmd === 't';
        const qx = prevQCtrl ? 2 * cx - prevQCtrl[0] : cx;
        const qy = prevQCtrl ? 2 * cy - prevQCtrl[1] : cy;
        quad(qx, qy, (rel ? cx : 0) + num(), (rel ? cy : 0) + num());
        break;
      }
      case 'A':
      case 'a': {
        const rel = cmd === 'a';
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num();
        const sweep = num();
        arc(rx, ry, rot, large, sweep, (rel ? cx : 0) + num(), (rel ? cy : 0) + num());
        break;
      }
      case 'Z':
      case 'z':
        ops.push('h');
        cx = sx;
        cy = sy;
        break;
      default:
        i++;
        break;
    }
    if (cmd !== 'C' && cmd !== 'c' && cmd !== 'S' && cmd !== 's') prevCtrl = undefined;
    if (cmd !== 'Q' && cmd !== 'q' && cmd !== 'T' && cmd !== 't') prevQCtrl = undefined;
  }
  return ops.join('\n');
}

// ---- SVG → PDF page ------------------------------------------------------------------------

interface PaintState {
  fill: string;
  stroke: string;
  strokeWidth: number;
  dash: string | undefined;
  lineJoin: number | undefined;
  fillOpacity: number;
  strokeOpacity: number;
}

const INITIAL: PaintState = {
  fill: '#000000',
  stroke: 'none',
  strokeWidth: 1,
  dash: undefined,
  lineJoin: undefined,
  fillOpacity: 1,
  strokeOpacity: 1,
};

function parseColor(value: string | undefined): [number, number, number] | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (rgb) {
    const parts = rgb[1]!.split(/[,\s/]+/).map(Number);
    return [(parts[0] ?? 0) / 255, (parts[1] ?? 0) / 255, (parts[2] ?? 0) / 255];
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1]!;
    const full =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h;
    return [
      Number.parseInt(full.slice(0, 2), 16) / 255,
      Number.parseInt(full.slice(2, 4), 16) / 255,
      Number.parseInt(full.slice(4, 6), 16) / 255,
    ];
  }
  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0],
    white: [1, 1, 1],
    red: [1, 0, 0],
    none: [0, 0, 0],
  };
  return named[v.toLowerCase()];
}

const BLEND_MODES: Record<string, string> = {
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  darken: 'Darken',
  lighten: 'Lighten',
  'color-dodge': 'ColorDodge',
  'color-burn': 'ColorBurn',
  'hard-light': 'HardLight',
  'soft-light': 'SoftLight',
  difference: 'Difference',
  exclusion: 'Exclusion',
};

interface DecodedImage {
  width: number;
  height: number;
  /** Raw bytes for the stream. */
  data: Uint8Array;
  filter: 'DCTDecode' | 'FlateDecode';
  colorSpace: 'DeviceRGB' | 'DeviceGray';
  alpha?: Uint8Array;
}

function jpegInfo(bytes: Uint8Array): { width: number; height: number; components: number } | undefined {
  let off = 2;
  while (off + 9 < bytes.length) {
    if (bytes[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = bytes[off + 1]!;
    const len = (bytes[off + 2]! << 8) | bytes[off + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: (bytes[off + 5]! << 8) | bytes[off + 6]!,
        width: (bytes[off + 7]! << 8) | bytes[off + 8]!,
        components: bytes[off + 9]!,
      };
    }
    if (marker === 0xda) break;
    off += 2 + len;
  }
  return undefined;
}

export function decodeImageForPdf(mime: string, bytes: Uint8Array): DecodedImage | undefined {
  try {
    if (mime === 'image/jpeg') {
      const info = jpegInfo(bytes);
      if (info && (info.components === 1 || info.components === 3)) {
        return {
          width: info.width,
          height: info.height,
          data: bytes,
          filter: 'DCTDecode',
          colorSpace: info.components === 1 ? 'DeviceGray' : 'DeviceRGB',
        };
      }
      const raw = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
      return rgbaToImage(raw.width, raw.height, raw.data as Uint8Array);
    }
    if (mime === 'image/png') {
      const png = PNG.sync.read(Buffer.from(bytes));
      return rgbaToImage(png.width, png.height, new Uint8Array(png.data));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function rgbaToImage(width: number, height: number, rgba: Uint8Array): DecodedImage {
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  let opaque = true;
  for (let i = 0, p = 0; i < width * height; i++) {
    rgb[p++] = rgba[i * 4]!;
    rgb[p++] = rgba[i * 4 + 1]!;
    rgb[p++] = rgba[i * 4 + 2]!;
    const a = rgba[i * 4 + 3]!;
    alpha[i] = a;
    if (a !== 255) opaque = false;
  }
  return {
    width,
    height,
    data: rgb,
    filter: 'FlateDecode',
    colorSpace: 'DeviceRGB',
    alpha: opaque ? undefined : alpha,
  };
}

interface SharedImage {
  id: number;
  width: number;
  height: number;
}

class PageContent {
  readonly ops: string[] = [];
  private names = new Map<string, string>();
  readonly imageRefs: string[] = [];
  readonly shadingRefs: string[] = [];
  readonly gsRefs: string[] = [];
  private gsKeys = new Map<string, string>();
  private counter = 0;
  usesFont = false;
  readonly warnings = new Set<string>();

  constructor(
    private pdf: PdfWriter,
    private defs: Map<string, Element>,
    private shared: Map<string, SharedImage>,
  ) {}

  private next(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  extGState(opacity: number, blend: string | undefined): string {
    const key = `${opacity}|${blend ?? ''}`;
    let name = this.gsKeys.get(key);
    if (!name) {
      name = this.next('GS');
      const id = this.pdf.add(
        `<< /Type /ExtGState /ca ${fmt(opacity)} /CA ${fmt(opacity)}${blend ? ` /BM /${blend}` : ''} >>`,
      );
      this.gsRefs.push(`/${name} ${id} 0 R`);
      this.gsKeys.set(key, name);
    }
    return name;
  }

  image(href: string): { name: string; width: number; height: number } | undefined {
    const known = this.shared.get(href);
    if (known) return { name: this.nameFor(href, known), ...known };
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(href);
    if (!m) return undefined;
    const bytes = new Uint8Array(Buffer.from(m[2]!, 'base64'));
    const decoded = decodeImageForPdf(m[1]!, bytes);
    if (!decoded) {
      this.warnings.add(`An image (${m[1]}) could not be embedded in the PDF`);
      return undefined;
    }
    let smask = '';
    if (decoded.alpha) {
      const maskId = this.pdf.addStream(
        `/Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} /ColorSpace /DeviceGray /BitsPerComponent 8`,
        decoded.alpha,
      );
      smask = ` /SMask ${maskId} 0 R`;
    }
    const id = this.pdf.addStream(
      `/Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} /ColorSpace /${decoded.colorSpace} /BitsPerComponent 8${smask}${decoded.filter === 'DCTDecode' ? ' /Filter /DCTDecode' : ''}`,
      decoded.data,
      { alreadyEncoded: decoded.filter === 'DCTDecode' },
    );
    const entry: SharedImage = { id, width: decoded.width, height: decoded.height };
    this.shared.set(href, entry);
    return { name: this.nameFor(href, entry), ...entry };
  }

  /** Resource name for an image object on this page (the object itself is shared). */
  private nameFor(href: string, image: SharedImage): string {
    let name = this.names.get(href);
    if (!name) {
      name = this.next('Im');
      this.imageRefs.push(`/${name} ${image.id} 0 R`);
      this.names.set(href, name);
    }
    return name;
  }

  /** Builds a PDF shading from an SVG gradient definition. */
  shading(id: string): string | undefined {
    const def = this.defs.get(id);
    if (!def) return undefined;
    const stops = children(def, 'stop').map((s) => ({
      offset: Number(s.getAttribute('offset') ?? 0),
      color: parseColor(s.getAttribute('stop-color') ?? '#000000') ?? ([0, 0, 0] as [number, number, number]),
    }));
    if (stops.length < 2) return undefined;
    stops.sort((a, b) => a.offset - b.offset);
    const functions: number[] = [];
    for (let i = 0; i < stops.length - 1; i++) {
      functions.push(
        this.pdf.add(
          `<< /FunctionType 2 /Domain [0 1] /C0 [${stops[i]!.color.map(fmt).join(' ')}] /C1 [${stops[i + 1]!.color.map(fmt).join(' ')}] /N 1 >>`,
        ),
      );
    }
    const bounds = stops.slice(1, -1).map((s) => fmt(s.offset));
    const stitch = this.pdf.add(
      `<< /FunctionType 3 /Domain [0 1] /Functions [${functions.map((f) => `${f} 0 R`).join(' ')}] /Bounds [${bounds.join(' ')}] /Encode [${functions.map(() => '0 1').join(' ')}] >>`,
    );
    const num = (name: string, fallback = 0) => Number(def.getAttribute(name) ?? fallback);
    const dict =
      def.tagName === 'radialGradient'
        ? `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [${fmt(num('cx'))} ${fmt(num('cy'))} 0 ${fmt(num('cx'))} ${fmt(num('cy'))} ${fmt(num('r'))}] /Function ${stitch} 0 R /Extend [true true] >>`
        : `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${fmt(num('x1'))} ${fmt(num('y1'))} ${fmt(num('x2'))} ${fmt(num('y2'))}] /Function ${stitch} 0 R /Extend [true true] >>`;
    const name = this.next('Sh');
    const shadingId = this.pdf.add(dict);
    this.shadingRefs.push(`/${name} ${shadingId} 0 R`);
    return name;
  }

  resourceDict(): string {
    const parts = ['/ProcSet [/PDF /Text /ImageB /ImageC]'];
    if (this.imageRefs.length) parts.push(`/XObject << ${this.imageRefs.join(' ')} >>`);
    if (this.shadingRefs.length) parts.push(`/Shading << ${this.shadingRefs.join(' ')} >>`);
    if (this.gsRefs.length) parts.push(`/ExtGState << ${this.gsRefs.join(' ')} >>`);
    if (this.usesFont) parts.push('/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>');
    return `<< ${parts.join(' ')} >>`;
  }
}

function matrixOf(transform: string | undefined): string | undefined {
  if (!transform) return undefined;
  const m = /matrix\(\s*([^)]+)\)/.exec(transform);
  if (m) {
    const n = m[1]!
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (n.length === 6) return `${n.map(fmt).join(' ')} cm`;
  }
  const t = /translate\(\s*([^)]+)\)/.exec(transform);
  if (t) {
    const n = t[1]!
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    return `1 0 0 1 ${fmt(n[0] ?? 0)} ${fmt(n[1] ?? 0)} cm`;
  }
  return undefined;
}

function rectPathOps(el: Element): string {
  const n = (name: string) => Number(el.getAttribute(name) ?? 0);
  const x = n('x');
  const y = n('y');
  const w = n('width');
  const h = n('height');
  return `${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re`;
}

function readState(el: Element, parent: PaintState): PaintState {
  const get = (name: string) => el.getAttribute(name) ?? undefined;
  const width = get('stroke-width');
  const join = get('stroke-linejoin');
  const fillOpacity = get('fill-opacity');
  const strokeOpacity = get('stroke-opacity');
  return {
    fill: get('fill') ?? parent.fill,
    stroke: get('stroke') ?? parent.stroke,
    strokeWidth: width !== undefined ? Number(width) : parent.strokeWidth,
    dash: get('stroke-dasharray') ?? parent.dash,
    lineJoin: join === 'round' ? 1 : join === 'bevel' ? 2 : parent.lineJoin,
    fillOpacity: fillOpacity !== undefined ? Number(fillOpacity) : parent.fillOpacity,
    strokeOpacity: strokeOpacity !== undefined ? Number(strokeOpacity) : parent.strokeOpacity,
  };
}

function paintOps(page: PageContent, state: PaintState, pathOps: string): string[] {
  const out: string[] = [];
  const gradient = /^url\(#([^)]+)\)$/.exec(state.fill);
  const fillColor = gradient ? undefined : parseColor(state.fill === 'none' ? undefined : state.fill);
  const strokeColor = state.stroke === 'none' ? undefined : parseColor(state.stroke);
  if (gradient) {
    const name = page.shading(gradient[1]!);
    if (name) {
      out.push('q', pathOps, 'W n', `/${name} sh`, 'Q');
    }
  }
  if (fillColor || strokeColor) {
    if (fillColor) out.push(`${fillColor.map(fmt).join(' ')} rg`);
    if (strokeColor) {
      out.push(`${strokeColor.map(fmt).join(' ')} RG`, `${fmt(state.strokeWidth)} w`);
      if (state.lineJoin !== undefined) out.push(`${state.lineJoin} j`);
      if (state.dash)
        out.push(
          `[${state.dash
            .trim()
            .split(/[\s,]+/)
            .map(Number)
            .map(fmt)
            .join(' ')}] 0 d`,
        );
      else out.push('[] 0 d');
    }
    out.push(pathOps);
    out.push(fillColor && strokeColor ? 'B' : fillColor ? 'f' : 'S');
  }
  return out;
}

function escapeText(s: string): string {
  return s.replace(/([()\\])/g, '\\$1');
}

function walk(el: Element, page: PageContent, state: PaintState, defs: Map<string, Element>): void {
  const tag = el.tagName;
  if (
    tag === 'defs' ||
    tag === 'clipPath' ||
    tag === 'filter' ||
    tag === 'linearGradient' ||
    tag === 'radialGradient'
  )
    return;
  const next = readState(el, state);
  const transform = matrixOf(el.getAttribute('transform') ?? undefined);
  const clip = /^url\(#([^)]+)\)$/.exec(el.getAttribute('clip-path') ?? '');
  const style = el.getAttribute('style') ?? '';
  const blend = /mix-blend-mode:\s*([a-z-]+)/.exec(style)?.[1];
  const opacityAttr = el.getAttribute('opacity');
  const opacity = opacityAttr !== null ? Number(opacityAttr) : 1;
  const needsQ = !!transform || !!clip || opacity < 1 || !!blend;
  if (needsQ) page.ops.push('q');
  if (opacity < 1 || (blend && BLEND_MODES[blend]))
    page.ops.push(`/${page.extGState(opacity, blend ? BLEND_MODES[blend] : undefined)} gs`);
  if (transform) page.ops.push(transform);
  if (clip) {
    const clipEl = defs.get(clip[1]!);
    const clipPath = clipEl ? children(clipEl, 'path')[0] : undefined;
    if (clipPath) page.ops.push(pathDataToPdf(clipPath.getAttribute('d') ?? ''), 'W n');
  }

  switch (tag) {
    case 'path': {
      const d = el.getAttribute('d');
      if (d) page.ops.push(...paintOps(page, next, pathDataToPdf(d)));
      break;
    }
    case 'rect':
      page.ops.push(...paintOps(page, next, rectPathOps(el)));
      break;
    case 'line': {
      const n = (name: string) => Number(el.getAttribute(name) ?? 0);
      page.ops.push(
        ...paintOps(
          page,
          { ...next, fill: 'none' },
          `${fmt(n('x1'))} ${fmt(n('y1'))} m ${fmt(n('x2'))} ${fmt(n('y2'))} l`,
        ),
      );
      break;
    }
    case 'use': {
      const href = (el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '').replace(/^#/, '');
      const def = defs.get(href);
      const d = def?.getAttribute('d');
      if (d) page.ops.push(...paintOps(page, next, pathDataToPdf(d)));
      break;
    }
    case 'image': {
      const href = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '';
      const img = page.image(href);
      if (img) {
        const n = (name: string) => Number(el.getAttribute(name) ?? 0);
        const x = n('x');
        const y = n('y');
        const w = n('width');
        const h = n('height');
        page.ops.push('q', `${fmt(w)} 0 0 ${fmt(-h)} ${fmt(x)} ${fmt(y + h)} cm`, `/${img.name} Do`, 'Q');
      }
      break;
    }
    case 'text': {
      const size = Number(el.getAttribute('font-size') ?? 10);
      const colour = parseColor(next.fill) ?? [0, 0, 0];
      page.usesFont = true;
      page.ops.push(
        'BT',
        `${colour.map(fmt).join(' ')} rg`,
        `/F1 ${fmt(size)} Tf`,
        `1 0 0 -1 ${fmt(Number(el.getAttribute('x') ?? 0))} ${fmt(Number(el.getAttribute('y') ?? 0))} Tm`,
        `(${escapeText(el.textContent ?? '')}) Tj`,
        'ET',
      );
      break;
    }
    default:
      break;
  }
  for (const child of children(el)) walk(child, page, next, defs);
  if (needsQ) page.ops.push('Q');
}

export interface SvgPage {
  svg: string;
  /** Page size in points. */
  width: number;
  height: number;
}

export interface PdfOptions {
  title?: string;
  author?: string;
}

/** Converts pages of preview SVG into one PDF document. */
export function svgPagesToPdf(
  pages: SvgPage[],
  options: PdfOptions = {},
): {
  pdf: Uint8Array;
  warnings: string[];
} {
  const pdf = new PdfWriter();
  const catalogId = pdf.alloc();
  const pagesId = pdf.alloc();
  const pageIds: number[] = [];
  const warnings = new Set<string>();
  const sharedImages = new Map<string, SharedImage>();

  for (const page of pages) {
    const doc = parseXml(page.svg, 'preview.svg');
    const root = doc.documentElement;
    if (!root) continue;
    const defs = new Map<string, Element>();
    for (const el of allElements(root)) {
      const id = el.getAttribute?.('id');
      if (id) defs.set(id, el);
    }
    const viewBox = (root.getAttribute('viewBox') ?? `0 0 ${page.width} ${page.height}`)
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const [vx, vy, vw, vh] = [
      viewBox[0] ?? 0,
      viewBox[1] ?? 0,
      viewBox[2] ?? page.width,
      viewBox[3] ?? page.height,
    ];
    const content = new PageContent(pdf, defs, sharedImages);
    // Flip to SVG's y-down space and move the view box origin to the page corner.
    content.ops.push('q', `1 0 0 -1 ${fmt(-vx)} ${fmt(vy + vh)} cm`);
    for (const child of children(root)) walk(child, content, INITIAL, defs);
    content.ops.push('Q');
    for (const w of content.warnings) warnings.add(w);
    const streamId = pdf.addStream('', new Uint8Array(Buffer.from(content.ops.join('\n'), 'latin1')));
    const pageId = pdf.add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${fmt(vw)} ${fmt(vh)}] /Resources ${content.resourceDict()} /Contents ${streamId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  pdf.set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
  pdf.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const info: Record<string, string> = { Producer: 'indesign-mcp' };
  if (options.title) info.Title = options.title;
  if (options.author) info.Author = options.author;
  return { pdf: pdf.build(catalogId, info), warnings: [...warnings] };
}
