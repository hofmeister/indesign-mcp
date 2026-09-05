// Font discovery and matching for previews: fonts installed on this computer (including Adobe
// Fonts activations) plus bundled fallbacks with Arial/Times/Courier-compatible metrics.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import * as fontkit from 'fontkit';
import { BUNDLED_FONTS } from '../generated/fonts.ts';
import { log } from '../log.ts';

export type FontFace = fontkit.Font;

export interface FaceInfo {
  family: string;
  style: string;
  postscriptName: string;
  path: string;
  index: number;
  weight: number;
  italic: boolean;
  bundled: boolean;
}

export interface FontMatch {
  face: FontFace;
  info: FaceInfo;
  /** true when a fallback replaced the requested font */
  substituted: boolean;
}

const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2', '.dfont']);

export function systemFontDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];
  if (process.platform === 'darwin') {
    dirs.push(
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      join(home, 'Library/Fonts'),
    );
    dirs.push(join(home, 'Library/Application Support/Adobe/CoreSync/plugins/livetype/.r'));
    dirs.push(join(home, 'Library/Application Support/Adobe/Fonts'));
  } else if (process.platform === 'win32') {
    dirs.push(join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
    if (process.env.APPDATA)
      dirs.push(join(process.env.APPDATA, 'Adobe', 'CoreSync', 'plugins', 'livetype', 'r'));
  } else {
    dirs.push(
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      join(home, '.fonts'),
      join(home, '.local/share/fonts'),
    );
  }
  if (process.env.INDESIGN_MCP_FONT_DIRS)
    dirs.push(...process.env.INDESIGN_MCP_FONT_DIRS.split(/[;:]/).filter(Boolean));
  return dirs.filter((d) => existsSync(d));
}

function weightFromStyle(style: string): number {
  const s = style.toLowerCase();
  if (/thin|hairline/.test(s)) return 100;
  if (/extralight|ultralight/.test(s)) return 200;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  if (/semibold|demibold/.test(s)) return 600;
  if (/extrabold|ultrabold|heavy/.test(s)) return 800;
  if (/black|ultra/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  return 400;
}

function italicFromStyle(style: string): boolean {
  return /italic|oblique|slanted/i.test(style);
}

export class FontCatalog {
  private faces: FaceInfo[] = [];
  private loaded = new Map<string, FontFace>();
  private scanned = false;
  readonly substitutions = new Map<string, string>();

  /** Scans font folders once. Cheap: only file names and name tables are read. */
  scan(options: { includeSystem?: boolean } = {}): void {
    if (this.scanned) return;
    this.scanned = true;
    for (const b of BUNDLED_FONTS) this.register(b.path, true);
    if (options.includeSystem !== false) {
      for (const dir of systemFontDirs()) this.scanDir(dir, 0);
    }
  }

  private scanDir(dir: string, depth: number): void {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        const st = statSync(p);
        if (st.isDirectory()) this.scanDir(p, depth + 1);
        else if (FONT_EXT.has(extname(e).toLowerCase()) || (!extname(e) && depth > 0 && st.size > 10_000))
          this.register(p, false);
      } catch {
        // unreadable entry
      }
    }
  }

  private register(path: string, bundled: boolean): void {
    try {
      const bytes = readFileSync(path);
      const parsed = fontkit.create(bytes as unknown as Buffer) as unknown as {
        fonts?: FontFace[];
      } & FontFace;
      const fonts = parsed.fonts ? parsed.fonts : [parsed];
      fonts.forEach((f, index) => {
        const family = (f.familyName ?? basename(path, extname(path))).trim();
        const style = (f.subfamilyName ?? 'Regular').trim();
        this.faces.push({
          family,
          style,
          postscriptName: f.postscriptName ?? '',
          path,
          index,
          weight: weightFromStyle(style),
          italic: italicFromStyle(style),
          bundled,
        });
        this.loaded.set(`${path}#${index}`, f);
      });
    } catch (e) {
      if (bundled) log.warn(`could not load bundled font ${path}: ${(e as Error).message}`);
    }
  }

  families(): string[] {
    this.scan();
    return [...new Set(this.faces.map((f) => f.family))].sort();
  }

  facesOf(family: string): FaceInfo[] {
    this.scan();
    const lower = family.toLowerCase();
    return this.faces.filter((f) => f.family.toLowerCase() === lower);
  }

  private load(info: FaceInfo): FontFace {
    const key = `${info.path}#${info.index}`;
    let f = this.loaded.get(key);
    if (!f) {
      const parsed = fontkit.create(readFileSync(info.path) as unknown as Buffer) as unknown as {
        fonts?: FontFace[];
      } & FontFace;
      f = parsed.fonts ? parsed.fonts[info.index]! : parsed;
      this.loaded.set(key, f);
    }
    return f;
  }

  /**
   * Finds the best face for an InDesign font family + style ("Minion Pro", "Semibold Italic").
   * Falls back to a bundled Liberation face with a similar classification.
   */
  match(family: string | undefined, style: string | undefined): FontMatch {
    this.scan();
    const fam = (family ?? '').trim();
    const sty = (style ?? 'Regular').trim();
    const wantWeight = weightFromStyle(sty);
    const wantItalic = italicFromStyle(sty);
    let candidates = this.facesOf(fam);
    let substituted = false;
    if (!candidates.length && fam) {
      // try postscript-ish names and family prefixes ("Helvetica Neue LT Std" -> "Helvetica Neue")
      const lower = fam.toLowerCase().replace(/\s+/g, '');
      candidates = this.faces.filter(
        (f) =>
          f.family.toLowerCase().replace(/\s+/g, '') === lower ||
          f.postscriptName.toLowerCase().startsWith(lower),
      );
    }
    if (!candidates.length) {
      substituted = true;
      const serif =
        /serif|times|georgia|garamond|minion|baskerville|caslon|book|palatino|cambria|didot|bodoni|playfair|merriweather|lora|roman/i.test(
          fam,
        ) && !/sans/i.test(fam);
      const mono = /mono|courier|consolas|menlo|code/i.test(fam);
      const fallbackFamily = mono ? 'Cousine' : serif ? 'Tinos' : 'Arimo';
      candidates = this.faces.filter((f) => f.family === fallbackFamily);
      if (!candidates.length) candidates = this.faces.filter((f) => f.bundled);
      if (fam) this.substitutions.set(`${fam} ${sty}`.trim(), fallbackFamily);
    }
    let best = candidates[0]!;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      const exactStyle = c.style.toLowerCase() === sty.toLowerCase() ? -1000 : 0;
      const score = exactStyle + Math.abs(c.weight - wantWeight) + (c.italic !== wantItalic ? 500 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) throw new Error('No fonts available for previews');
    return { face: this.load(best), info: best, substituted };
  }

  /** Raw bytes of every face used so far (for renderers that need font files). */
  bytesFor(info: FaceInfo): Uint8Array {
    return new Uint8Array(readFileSync(info.path));
  }
}

let shared: FontCatalog | undefined;
export function fontCatalog(): FontCatalog {
  shared ??= new FontCatalog();
  return shared;
}
