// Exporting finished documents: PDF, JPEG and PNG. Uses the installed InDesign when there is one
// (identical to File > Export), and the built-in renderer otherwise.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import type { IdmlDocument } from '../idml/document.ts';
import { findPage, listPages } from '../idml/pages.ts';
import { detectInDesign, exportWithInDesign } from '../preview/indesign.ts';
import { svgToPng } from '../preview/png.ts';
import { type RenderOptions, renderPageSvg, renderSpreadSvg } from '../preview/svg.ts';
import { svgPagesToPdf } from './pdf.ts';

export type ExportFormat = 'pdf' | 'png' | 'jpeg';

export interface ExportOptions extends RenderOptions {
  format: ExportFormat;
  /** Output file (PDF, or a single image) or the base name for a set of images. */
  path: string;
  /** Pages to export; all pages when omitted. */
  pages?: (number | string)[];
  /** Export whole spreads instead of single pages. */
  spreads?: boolean;
  dpi?: number;
  /** JPEG quality, 1–100 (default 90). */
  quality?: number;
  renderer?: 'auto' | 'builtin' | 'indesign';
  title?: string;
}

export interface ExportResult {
  files: string[];
  renderer: 'builtin' | 'indesign';
  warnings: string[];
  substitutions: Record<string, string>;
}

function resolvePages(doc: IdmlDocument, refs: (number | string)[] | undefined): number[] {
  const all = listPages(doc);
  if (!refs?.length) return all.map((p) => p.index);
  const out: number[] = [];
  for (const ref of refs) {
    if (typeof ref === 'string' && /^\d+\s*-\s*\d+$/.test(ref)) {
      const [from, to] = ref.split('-').map((s) => Number(s.trim()));
      for (let i = from!; i <= to!; i++) if (all.some((p) => p.index === i)) out.push(i);
    } else out.push(findPage(doc, ref).index);
  }
  return [...new Set(out)];
}

/** One SVG per exported sheet (page or spread), skipping spreads already covered. */
function sheetSvgs(doc: IdmlDocument, pages: number[], options: ExportOptions) {
  const infos = listPages(doc);
  const seenSpreads = new Set<string>();
  const sheets: { page: number; svg: string; width: number; height: number }[] = [];
  const warnings: string[] = [];
  const substitutions: Record<string, string> = {};
  for (const p of pages) {
    if (options.spreads) {
      const info = infos.find((i) => i.index === p);
      if (info && seenSpreads.has(info.spreadId)) continue;
      if (info) seenSpreads.add(info.spreadId);
    }
    const r = options.spreads ? renderSpreadSvg(doc, p, options) : renderPageSvg(doc, p, options);
    warnings.push(...r.warnings);
    Object.assign(substitutions, r.substitutions);
    sheets.push({ page: p, svg: r.svg, width: r.width, height: r.height });
  }
  return { sheets, warnings: [...new Set(warnings)], substitutions };
}

function outputPath(base: string, format: ExportFormat, page: number | undefined, many: boolean): string {
  const ext = format === 'jpeg' ? '.jpg' : `.${format}`;
  const dir = dirname(base);
  const name = basename(base, extname(base));
  mkdirSync(dir, { recursive: true });
  return join(dir, many && page !== undefined ? `${name}-${page}${ext}` : `${name}${ext}`);
}

async function rasterSheet(
  svg: string,
  widthPt: number,
  dpi: number,
): Promise<{ png: Uint8Array; width: number; height: number }> {
  const width = Math.max(1, Math.round((widthPt * dpi) / 72));
  return svgToPng(svg, { width });
}

function pngToJpeg(png: Uint8Array, quality: number): Uint8Array {
  const decoded = PNG.sync.read(Buffer.from(png));
  // JPEG has no alpha: composite onto white first.
  const data = Buffer.from(decoded.data);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    if (a < 1) {
      data[i] = Math.round(data[i]! * a + 255 * (1 - a));
      data[i + 1] = Math.round(data[i + 1]! * a + 255 * (1 - a));
      data[i + 2] = Math.round(data[i + 2]! * a + 255 * (1 - a));
      data[i + 3] = 255;
    }
  }
  return new Uint8Array(
    encodeJpeg({ data, width: decoded.width, height: decoded.height }, Math.max(1, Math.min(100, quality)))
      .data,
  );
}

/** Writes the document out in the requested format. */
export async function exportDocument(doc: IdmlDocument, options: ExportOptions): Promise<ExportResult> {
  const pages = resolvePages(doc, options.pages);
  if (!pages.length) throw new Error('No pages to export');
  const choice = options.renderer ?? 'auto';
  const target = resolve(options.path);

  if (choice !== 'builtin' && doc.path) {
    const installed = detectInDesign();
    if (!installed && choice === 'indesign')
      throw new Error('Adobe InDesign is not installed on this computer; use renderer "builtin"');
    if (installed) {
      try {
        const out = outputPath(target, options.format, undefined, false);
        const r = await exportWithInDesign(doc.path, out, options.format, {
          pages: pages.join(','),
          dpi: options.dpi,
          quality: options.quality,
          spreads: options.spreads,
          bleed: options.bleed,
        });
        return { files: r.files, renderer: 'indesign', warnings: [], substitutions: {} };
      } catch (e) {
        if (choice === 'indesign') throw e;
      }
    }
  }

  const { sheets, warnings, substitutions } = sheetSvgs(doc, pages, options);
  const files: string[] = [];
  if (options.format === 'pdf') {
    const { pdf, warnings: pdfWarnings } = svgPagesToPdf(
      sheets.map((s) => ({ svg: s.svg, width: s.width, height: s.height })),
      { title: options.title ?? (doc.path ? basename(doc.path) : undefined) },
    );
    const out = outputPath(target, 'pdf', undefined, false);
    writeFileSync(out, pdf);
    files.push(out);
    warnings.push(...pdfWarnings);
  } else {
    const dpi = options.dpi ?? 150;
    for (const sheet of sheets) {
      const { png } = await rasterSheet(sheet.svg, sheet.width, dpi);
      const out = outputPath(target, options.format, sheet.page, sheets.length > 1);
      writeFileSync(out, options.format === 'jpeg' ? pngToJpeg(png, options.quality ?? 90) : png);
      files.push(out);
    }
  }
  return {
    files,
    renderer: 'builtin',
    warnings: [
      ...new Set([
        ...warnings,
        'Exported with the built-in renderer — install InDesign for a print-exact file, or open the IDML and export from InDesign.',
      ]),
    ],
    substitutions,
  };
}
