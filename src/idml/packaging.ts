// "Package" a document the way InDesign does: a folder with the document, copies of every linked
// image, a font report and a summary the printer or client can read.
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fontCatalog } from '../preview/fonts.ts';
import { IdmlDocument } from './document.ts';
import { graphicHits, type LinkRecord, linkRecord, repointLink } from './links.ts';
import { listPages } from './pages.ts';
import { preflight, preflightToMarkdown } from './preflight.ts';
import { fontsUsed, listSwatches } from './styles.ts';

export interface PackageOptions {
  /** Destination folder; it is created if needed. */
  folder: string;
  /** File name for the packaged document (default: the original name). */
  name?: string;
  /** Copy linked images into a Links folder and repoint the document (default true). */
  copyLinks?: boolean;
  /** Copy the font files used, when they can be found (default false — check your licence). */
  copyFonts?: boolean;
  /** Write a preflight report next to the document (default true). */
  includeReport?: boolean;
}

export interface PackagedLink {
  fileName: string;
  from: string;
  to: string | undefined;
  copied: boolean;
  missing: boolean;
  bytes: number | undefined;
}

export interface PackagedFont {
  family: string;
  file: string | undefined;
  copied: boolean;
  installed: boolean;
}

export interface PackageResult {
  folder: string;
  document: string;
  links: PackagedLink[];
  fonts: PackagedFont[];
  reportPath: string | undefined;
  missingLinks: number;
  missingFonts: number;
  totalBytes: number;
}

function uniqueName(dir: string, fileName: string, used: Set<string>): string {
  const ext = extname(fileName);
  const base = basename(fileName, ext);
  let candidate = fileName;
  let n = 2;
  while (used.has(candidate.toLowerCase()) || existsSync(join(dir, candidate)))
    candidate = `${base}-${n++}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Builds the folder. The source document is never modified. */
export function packageDocument(doc: IdmlDocument, options: PackageOptions): PackageResult {
  const folder = options.folder;
  mkdirSync(folder, { recursive: true });
  const docName = options.name ?? (doc.path ? basename(doc.path) : 'document.idml');
  const copy = IdmlDocument.fromBytes(doc.toBytes(), doc.path);

  const links: PackagedLink[] = [];
  let totalBytes = 0;
  if (options.copyLinks !== false) {
    const linksDir = join(folder, 'Links');
    const used = new Set<string>();
    let made = false;
    for (const hit of graphicHits(copy)) {
      const rec = linkRecord(hit);
      if (rec.embedded) continue;
      if (!rec.exists) {
        links.push({
          fileName: rec.fileName,
          from: rec.path,
          to: undefined,
          copied: false,
          missing: true,
          bytes: undefined,
        });
        continue;
      }
      if (!made) {
        mkdirSync(linksDir, { recursive: true });
        made = true;
      }
      const target = uniqueName(linksDir, rec.fileName, used);
      const to = join(linksDir, target);
      if (!existsSync(to)) copyFileSync(rec.path, to);
      const bytes = statSync(to).size;
      totalBytes += bytes;
      if (hit.link) repointLink(hit.link, to);
      links.push({ fileName: target, from: rec.path, to, copied: true, missing: false, bytes });
    }
  } else {
    for (const hit of graphicHits(copy)) {
      const rec = linkRecord(hit);
      if (rec.embedded) continue;
      links.push({
        fileName: rec.fileName,
        from: rec.path,
        to: undefined,
        copied: false,
        missing: !rec.exists,
        bytes: rec.sizeBytes,
      });
    }
  }

  const catalog = fontCatalog();
  const fontsDir = join(folder, 'Document fonts');
  const fonts: PackagedFont[] = [];
  for (const family of fontsUsed(copy)) {
    const match = catalog.match(family, 'Regular');
    const installed = !match.substituted;
    let copied = false;
    let file: string | undefined = installed ? match.info.path : undefined;
    if (installed && options.copyFonts && !match.info.bundled) {
      try {
        mkdirSync(fontsDir, { recursive: true });
        const target = join(fontsDir, basename(match.info.path));
        if (!existsSync(target)) copyFileSync(match.info.path, target);
        file = target;
        copied = true;
        totalBytes += statSync(target).size;
      } catch {
        copied = false;
      }
    }
    fonts.push({ family, file, copied, installed });
  }

  const docPath = join(folder, docName.endsWith('.idml') ? docName : `${docName}.idml`);
  copy.save(docPath);
  totalBytes += statSync(docPath).size;

  let reportPath: string | undefined;
  if (options.includeReport !== false) {
    reportPath = join(folder, 'Instructions.md');
    writeFileSync(reportPath, packageReport(doc, docName, links, fonts));
  }

  return {
    folder,
    document: docPath,
    links,
    fonts,
    reportPath,
    missingLinks: links.filter((l) => l.missing).length,
    missingFonts: fonts.filter((f) => !f.installed).length,
    totalBytes,
  };
}

function packageReport(
  doc: IdmlDocument,
  docName: string,
  links: PackagedLink[],
  fonts: PackagedFont[],
): string {
  const pages = listPages(doc);
  const swatches = listSwatches(doc).filter((s) => !s.builtIn && s.kind === 'color');
  const report = preflight(doc);
  const lines: string[] = [
    `# ${docName}`,
    '',
    `Packaged ${new Date().toISOString().slice(0, 10)}.`,
    '',
    '## Document',
    `- ${pages.length} page(s): ${pages.map((p) => p.name).join(', ')}`,
    `- Page size: ${Math.round(((pages[0]?.width ?? 0) / 2.8346) * 10) / 10} × ${Math.round(((pages[0]?.height ?? 0) / 2.8346) * 10) / 10} mm`,
    '',
    '## Fonts',
    ...(fonts.length
      ? fonts.map(
          (f) =>
            `- ${f.family}${f.copied ? ' — included in "Document fonts"' : f.installed ? ' — installed on the packaging computer, not copied' : ' — **not available, must be installed**'}`,
        )
      : ['- None']),
    '',
    '## Linked images',
    ...(links.length
      ? links.map(
          (l) =>
            `- ${l.fileName}${l.missing ? ' — **missing**' : l.copied ? ` — copied to Links/ (${Math.round((l.bytes ?? 0) / 1024)} kB)` : ` — left at ${l.from}`}`,
        )
      : ['- None']),
    '',
    '## Colours',
    ...(swatches.length
      ? swatches.map((s) => `- ${s.name} (${s.space ?? '?'}${s.model === 'Spot' ? ', spot' : ''})`)
      : ['- Only the built-in swatches']),
    '',
    '## Preflight',
    preflightToMarkdown(report),
  ];
  return lines.join('\n');
}

export type { LinkRecord };
