// Preview facade: picks the renderer (InDesign if installed and wanted, else built-in) and produces PNGs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { IdmlDocument } from '../idml/document.ts';
import type { Rect } from '../idml/geometry.ts';
import { detectInDesign, renderWithInDesign } from './indesign.ts';
import { svgToPng } from './png.ts';
import { type RenderOptions, renderItemSvg, renderPageSvg, renderSpreadSvg } from './svg.ts';

export type RendererChoice = 'auto' | 'builtin' | 'indesign';

export interface PreviewOptions extends RenderOptions {
  renderer?: RendererChoice;
  /** Output width in pixels (default 1200). */
  width?: number;
  dpi?: number;
  save?: boolean;
}

export interface PreviewResult {
  png: Uint8Array;
  width: number;
  height: number;
  renderer: 'builtin' | 'indesign';
  warnings: string[];
  substitutions: Record<string, string>;
  savedTo?: string;
}

function previewDir(doc: IdmlDocument): string {
  const base = doc.path ?? join(process.cwd(), 'untitled.idml');
  const dir = join(dirname(base), `${basename(base, extname(base))}.previews`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function rasterize(
  svg: {
    svg: string;
    width: number;
    height: number;
    warnings: string[];
    substitutions: Record<string, string>;
  },
  options: PreviewOptions,
): Promise<PreviewResult> {
  const width = options.width ?? (options.dpi ? Math.round((svg.width * options.dpi) / 72) : 1200);
  const { png, width: w, height: h } = await svgToPng(svg.svg, { width });
  return {
    png,
    width: w,
    height: h,
    renderer: 'builtin',
    warnings: svg.warnings,
    substitutions: svg.substitutions,
  };
}

interface ExactRender {
  pngs: Map<number, Uint8Array>;
  warnings: string[];
}

async function tryInDesign(
  doc: IdmlDocument,
  pages: number[],
  options: PreviewOptions,
  spread: boolean,
): Promise<ExactRender | undefined> {
  const choice = options.renderer ?? 'auto';
  if (choice === 'builtin' || !doc.path) return undefined;
  if (!detectInDesign()) {
    if (choice === 'indesign')
      throw new Error('Adobe InDesign is not installed on this computer; use renderer "builtin"');
    return undefined;
  }
  try {
    const dpi = options.dpi ?? (options.width ? Math.round((options.width / 8.27) * 1) : 150);
    const r = await renderWithInDesign(doc.path, pages, { dpi, spread });
    return { pngs: r.pngs, warnings: r.warnings };
  } catch (e) {
    if (choice === 'indesign') throw e;
    return undefined;
  }
}

export async function previewPage(
  doc: IdmlDocument,
  pageRef: number | string,
  options: PreviewOptions = {},
): Promise<PreviewResult> {
  const pageNumber = typeof pageRef === 'number' ? pageRef : Number(pageRef) || 1;
  const exact = await tryInDesign(doc, [pageNumber], options, false);
  let result: PreviewResult;
  if (exact?.pngs.get(pageNumber)) {
    const png = exact.pngs.get(pageNumber)!;
    const dims = pngDims(png);
    result = {
      png,
      width: dims.width,
      height: dims.height,
      renderer: 'indesign',
      warnings: exact.warnings,
      substitutions: {},
    };
  } else {
    result = await rasterize(renderPageSvg(doc, pageRef, options), options);
  }
  if (options.save !== false) {
    const file = join(previewDir(doc), `page-${pageNumber}.png`);
    writeFileSync(file, result.png);
    result.savedTo = file;
  }
  return result;
}

export async function previewSpread(
  doc: IdmlDocument,
  pageRef: number | string,
  options: PreviewOptions = {},
): Promise<PreviewResult> {
  const pageNumber = typeof pageRef === 'number' ? pageRef : Number(pageRef) || 1;
  const exact = await tryInDesign(doc, [pageNumber], options, true);
  let result: PreviewResult;
  if (exact?.pngs.get(pageNumber)) {
    const png = exact.pngs.get(pageNumber)!;
    const dims = pngDims(png);
    result = {
      png,
      width: dims.width,
      height: dims.height,
      renderer: 'indesign',
      warnings: exact.warnings,
      substitutions: {},
    };
  } else {
    result = await rasterize(renderSpreadSvg(doc, pageRef, options), {
      ...options,
      width: options.width ?? 1600,
    });
  }
  if (options.save !== false) {
    const file = join(previewDir(doc), `spread-page-${pageNumber}.png`);
    writeFileSync(file, result.png);
    result.savedTo = file;
  }
  return result;
}

export async function previewItem(
  doc: IdmlDocument,
  pageRef: number | string,
  bounds: Rect,
  options: PreviewOptions = {},
): Promise<PreviewResult> {
  const padding = Math.max(bounds.width, bounds.height) * 0.15 + 8;
  const result = await rasterize(renderItemSvg(doc, bounds, pageRef, padding, options), {
    ...options,
    width: options.width ?? 900,
  });
  return result;
}

/** A contact sheet of all pages laid out in a grid. */
export async function previewDocument(
  doc: IdmlDocument,
  options: PreviewOptions & { columns?: number; pageWidth?: number } = {},
): Promise<PreviewResult> {
  const { listPages } = await import('../idml/pages.ts');
  const pages = listPages(doc);
  const cols = options.columns ?? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(pages.length))));
  const cellW = options.pageWidth ?? 300;
  const warnings: string[] = [];
  const substitutions: Record<string, string> = {};
  const tiles: { svg: string; w: number; h: number }[] = [];
  for (const p of pages) {
    // Each tile gets its own id namespace: the tiles are inlined into one SVG below, and duplicate
    // ids would make every glyph `use` resolve to the first page's outlines.
    const r = renderPageSvg(doc, p.index, { ...options, idPrefix: `p${p.index}-` });
    warnings.push(...r.warnings);
    Object.assign(substitutions, r.substitutions);
    tiles.push({ svg: r.svg, w: r.width, h: r.height });
  }
  const scale = cellW / Math.max(...tiles.map((t) => t.w));
  const cellH = Math.max(...tiles.map((t) => t.h)) * scale;
  const gap = 16;
  const label = 14;
  const rows = Math.ceil(tiles.length / cols);
  const totalW = cols * cellW + (cols + 1) * gap;
  const totalH = rows * (cellH + label) + (rows + 1) * gap;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}"><rect width="${totalW}" height="${totalH}" fill="rgb(235,235,235)"/>`,
  ];
  tiles.forEach((t, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = gap + c * (cellW + gap);
    const y = gap + r * (cellH + label + gap);
    const inner = t.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    const vb = /viewBox="([^"]+)"/.exec(t.svg)?.[1]?.split(/\s+/).map(Number) ?? [0, 0, t.w, t.h];
    parts.push(
      `<svg x="${x}" y="${y}" width="${t.w * scale}" height="${t.h * scale}" viewBox="${vb.join(' ')}">${inner}</svg>`,
    );
    parts.push(
      `<rect x="${x}" y="${y}" width="${t.w * scale}" height="${t.h * scale}" fill="none" stroke="rgb(180,180,180)" stroke-width="0.5"/>`,
    );
    parts.push(
      `<text x="${x + (t.w * scale) / 2}" y="${y + t.h * scale + label - 3}" font-family="sans-serif" font-size="10" text-anchor="middle" fill="rgb(80,80,80)">${pages[i]!.index}</text>`,
    );
  });
  parts.push('</svg>');
  const { png, width, height } = await svgToPng(parts.join(''), {
    width: options.width ?? Math.min(2400, totalW * 2),
  });
  const result: PreviewResult = {
    png,
    width,
    height,
    renderer: 'builtin',
    warnings: [...new Set(warnings)],
    substitutions,
  };
  if (options.save !== false) {
    const file = join(previewDir(doc), 'all-pages.png');
    writeFileSync(file, png);
    result.savedTo = file;
  }
  return result;
}

function pngDims(png: Uint8Array): { width: number; height: number } {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}
