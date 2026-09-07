// Optional pixel-exact renderer: if Adobe InDesign is installed on this computer, drive it through
// its scripting interface to open the IDML and export pages as PNG. Never required.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { log } from '../log.ts';

export interface InDesignInstall {
  platform: 'darwin' | 'win32';
  appPath: string;
  name: string;
}

export function detectInDesign(): InDesignInstall | undefined {
  if (process.env.INDESIGN_MCP_DISABLE_INDESIGN === '1') return undefined;
  if (process.platform === 'darwin') {
    const apps = '/Applications';
    try {
      const dirs = readdirSync(apps).filter((d) => /^Adobe InDesign/i.test(d));
      dirs.sort().reverse();
      for (const d of dirs) {
        const inner = readdirSync(join(apps, d)).find((f) => /^Adobe InDesign.*\.app$/i.test(f));
        if (inner) return { platform: 'darwin', appPath: join(apps, d, inner), name: d };
      }
    } catch {
      return undefined;
    }
  } else if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
      Boolean,
    ) as string[]) {
      const adobe = join(base, 'Adobe');
      try {
        const dirs = readdirSync(adobe)
          .filter((d) => /^Adobe InDesign/i.test(d))
          .sort()
          .reverse();
        for (const d of dirs) {
          const exe = join(adobe, d, 'InDesign.exe');
          if (existsSync(exe)) return { platform: 'win32', appPath: exe, name: d };
        }
      } catch {
        // no Adobe folder
      }
    }
  }
  return undefined;
}

/** ExtendScript that exports the given pages of an IDML as PNG files into `outDir`. */
function exportScript(
  idmlPath: string,
  outDir: string,
  pages: number[],
  dpi: number,
  spread: boolean,
): string {
  const js = (s: string) => JSON.stringify(s);
  return `
(function () {
  app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
  var pageReports = [];
  // A document left open by an earlier run would be re-exported from its stale in-memory copy.
  for (var d = app.documents.length - 1; d >= 0; d--) {
    try {
      if (app.documents[d].fullName && String(app.documents[d].fullName) === ${js(idmlPath)})
        app.documents[d].close(SaveOptions.NO);
    } catch (e) {}
  }
  var doc = app.open(File(${js(idmlPath)}), false);
  try {
    var documentPages = doc.pages.length;
    var spreadCount = doc.spreads.length;
    var prefs = app.pngExportPreferences;
    prefs.exportResolution = ${Math.max(36, Math.min(2400, Math.round(dpi)))};
    prefs.pngQuality = PNGQualityEnum.MAXIMUM;
    prefs.pngColorSpace = PNGColorSpaceEnum.RGB;
    prefs.antiAlias = true;
    prefs.simulateOverprint = false;
    prefs.transparentBackground = false;
    prefs.useDocumentBleeds = false;
    prefs.exportingSpread = ${spread ? 'true' : 'false'};
    var pages = ${JSON.stringify(pages)};
    for (var i = 0; i < pages.length; i++) {
      var p = doc.pages[pages[i] - 1];
      if (!p) continue;
      prefs.pngExportRange = ExportRangeOrAllPages.EXPORT_RANGE;
      // Address the page by absolute position. A page *name* carries the section prefix and
      // numbering style, so "3" can mean another page — or no page at all — once a section is set.
      prefs.pageString = "+" + pages[i];
      var own = 0, inherited = 0;
      try { own = p.pageItems.length; } catch (e) {}
      try { inherited = p.masterPageItems ? p.masterPageItems.length : 0; } catch (e) {}
      pageReports.push('{"page":' + pages[i] + ',"name":"' + String(p.name).replace(/"/g, "'") +
        '","items":' + own + ',"masterItems":' + inherited + '}');
      doc.exportFile(ExportFormat.PNG_FORMAT, File(${js(outDir)} + "/page-" + pages[i] + ".png"), false);
    }
  } finally {
    doc.close(SaveOptions.NO);
    try {
      var f = File(${js(outDir)} + "/report.json");
      f.open("w");
      f.write('{"documentPages":' + documentPages + ',"spreads":' + spreadCount +
        ',"pages":[' + pageReports.join(',') + ']}');
      f.close();
    } catch (e) {}
  }
})();
`;
}

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`InDesign did not finish within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export interface InDesignPageReport {
  page: number;
  /** The page name InDesign gave it — carries any section prefix. */
  name: string;
  /** Items on the page itself. */
  items: number;
  /** Items it inherits from its master. */
  masterItems: number;
}

export interface InDesignRenderResult {
  pngs: Map<number, Uint8Array>;
  app: string;
  /** What InDesign saw when it opened the file. Empty when it could not be read back. */
  report?: { documentPages: number; spreads: number; pages: InDesignPageReport[] };
  /** Things worth telling the caller about the export, e.g. a page that came out bare. */
  warnings: string[];
}

/**
 * Exports pages through the installed InDesign. Throws when InDesign is unavailable or fails;
 * callers fall back to the built-in renderer.
 */
export async function renderWithInDesign(
  idmlPath: string,
  pages: number[],
  options: { dpi?: number; spread?: boolean; timeoutMs?: number } = {},
): Promise<InDesignRenderResult> {
  const install = detectInDesign();
  if (!install) throw new Error('Adobe InDesign is not installed on this computer');
  const outDir = mkdtempSync(join(tmpdir(), 'indesign-mcp-render-'));
  const script = exportScript(idmlPath, outDir, pages, options.dpi ?? 150, options.spread ?? false);
  const jsxPath = join(outDir, 'export.jsx');
  writeFileSync(jsxPath, script);
  const timeout = options.timeoutMs ?? 120_000;
  try {
    if (install.platform === 'darwin') {
      const apple = `tell application id "com.adobe.InDesign"\n do script (POSIX file ${JSON.stringify(jsxPath)}) language javascript\nend tell`;
      const r = await runCommand('osascript', ['-e', apple], timeout);
      if (r.code !== 0) throw new Error(`osascript failed: ${r.stderr.trim() || r.stdout.trim()}`);
    } else {
      const vbs = `Set app = CreateObject("InDesign.Application")\napp.DoScript ${JSON.stringify(jsxPath).replace(/\\\\/g, '\\')}, 1246973031\n`;
      const vbsPath = join(outDir, 'export.vbs');
      writeFileSync(vbsPath, vbs);
      const r = await runCommand('cscript', ['//nologo', vbsPath], timeout);
      if (r.code !== 0) throw new Error(`cscript failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    const pngs = new Map<number, Uint8Array>();
    for (const p of pages) {
      // InDesign appends page names for multi-page exports; accept either naming
      const candidates = [
        join(outDir, `page-${p}.png`),
        ...readdirSync(outDir)
          .filter((f) => f.startsWith(`page-${p}`) && f.endsWith('.png'))
          .map((f) => join(outDir, f)),
      ];
      const hit = candidates.find((c) => existsSync(c));
      if (hit) pngs.set(p, new Uint8Array(readFileSync(hit)));
    }
    if (!pngs.size) throw new Error('InDesign exported no images');

    // Read back what InDesign actually opened. When a page renders with nothing but its master
    // items, this is the difference between a mystery and a report you can act on.
    let report: InDesignRenderResult['report'];
    const warnings: string[] = [];
    try {
      report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    } catch {
      // no report; not worth failing the render over
    }
    if (report) {
      log.info(
        `InDesign opened ${idmlPath}: ${report.documentPages} page(s), ${report.spreads} spread(s); ` +
          report.pages
            .map((p) => `p${p.page} "${p.name}" ${p.items} item(s), ${p.masterItems} from master`)
            .join('; '),
      );
      for (const p of report.pages)
        if (p.items === 0 && p.masterItems > 0)
          warnings.push(
            `InDesign found no items of its own on page ${p.page} ("${p.name}") — only ${p.masterItems} inherited from its master. The render will show the master page alone.`,
          );
    }
    return { pngs, app: install.name, report, warnings };
  } finally {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Result of asking InDesign to run a trivial script. Detection alone only proves the application is
 * installed: on macOS the first script also needs the user to grant automation access, and until
 * that consent dialog is answered every `do script` blocks until it times out.
 */
const NO_ANSWER =
  'InDesign did not answer a test script. macOS may still be waiting for you to allow automation access — look for a "wants access to control Adobe InDesign" dialog, or tick InDesign under System Settings > Privacy & Security > Automation. A modal dialog or a long-running script inside InDesign looks the same from here.';

export type ScriptingProbe =
  | { ok: true; app: string }
  | {
      ok: false;
      app?: string;
      reason: 'not-installed' | 'no-permission' | 'not-responding' | 'error';
      message: string;
    };

/** Runs a one-line script to check that InDesign really accepts scripts right now. */
export async function probeInDesignScripting(timeoutMs = 15_000): Promise<ScriptingProbe> {
  const install = detectInDesign();
  if (!install)
    return {
      ok: false,
      reason: 'not-installed',
      message: 'Adobe InDesign is not installed on this computer',
    };
  try {
    if (install.platform === 'darwin') {
      const apple = `with timeout of ${Math.max(2, Math.round(timeoutMs / 1000))} seconds\ntell application id "com.adobe.InDesign" to do script "1+1" language javascript\nend timeout`;
      const r = await runCommand('osascript', ['-e', apple], timeoutMs + 5_000);
      const out = `${r.stdout}${r.stderr}`.trim();
      if (r.code === 0 && r.stdout.trim() === '2') return { ok: true, app: install.name };
      if (/-1712|timed out/i.test(out))
        return { ok: false, app: install.name, reason: 'not-responding', message: NO_ANSWER };
      if (/-1743|not authori[sz]ed/i.test(out))
        return {
          ok: false,
          app: install.name,
          reason: 'no-permission',
          message:
            'Automation access to InDesign was refused. Allow it under System Settings > Privacy & Security > Automation.',
        };
      return {
        ok: false,
        app: install.name,
        reason: 'error',
        message: out || `osascript exited with ${r.code}`,
      };
    }
    const outDir = mkdtempSync(join(tmpdir(), 'indesign-mcp-probe-'));
    try {
      const jsxPath = join(outDir, 'probe.jsx');
      writeFileSync(jsxPath, '1+1;');
      const vbsPath = join(outDir, 'probe.vbs');
      writeFileSync(
        vbsPath,
        `Set app = CreateObject("InDesign.Application")\napp.DoScript ${JSON.stringify(jsxPath).replace(/\\\\/g, '\\')}, 1246973031\n`,
      );
      const r = await runCommand('cscript', ['//nologo', vbsPath], timeoutMs);
      if (r.code === 0) return { ok: true, app: install.name };
      return {
        ok: false,
        app: install.name,
        reason: 'error',
        message: `${r.stderr}${r.stdout}`.trim() || `cscript exited with ${r.code}`,
      };
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } catch (e) {
    const message = (e as Error).message;
    return {
      ok: false,
      app: install.name,
      reason: 'not-responding',
      message: /did not finish within/.test(message) ? NO_ANSWER : message,
    };
  }
}

/** ExtendScript that exports a document as PDF, JPEG or PNG. */
function fileExportScript(
  idmlPath: string,
  outPath: string,
  format: 'pdf' | 'jpeg' | 'png',
  options: {
    pages?: string;
    dpi?: number;
    quality?: number;
    spreads?: boolean;
    bleed?: boolean;
    marks?: boolean;
  },
): string {
  const js = (s: string) => JSON.stringify(s);
  const dpi = Math.max(36, Math.min(2400, Math.round(options.dpi ?? 300)));
  const range = options.pages ? `prefs.pageString = ${js(options.pages)};` : '';
  const body =
    format === 'pdf'
      ? `
    var preset = app.pdfExportPresets.itemByName("[High Quality Print]");
    var prefs = app.pdfExportPreferences;
    prefs.pageRange = ${options.pages ? js(options.pages) : 'PageRange.ALL_PAGES'};
    prefs.exportReaderSpreads = ${options.spreads ? 'true' : 'false'};
    prefs.useDocumentBleedWithPDF = ${options.bleed || options.marks ? 'true' : 'false'};
    prefs.cropMarks = ${options.marks ? 'true' : 'false'};
    prefs.bleedMarks = ${options.marks ? 'true' : 'false'};
    prefs.registrationMarks = ${options.marks ? 'true' : 'false'};
    prefs.colorBars = ${options.marks ? 'true' : 'false'};
    prefs.pageInformationMarks = ${options.marks ? 'true' : 'false'};
    if (preset.isValid) doc.exportFile(ExportFormat.PDF_TYPE, File(${js(outPath)}), false, preset);
    else doc.exportFile(ExportFormat.PDF_TYPE, File(${js(outPath)}), false);`
      : format === 'jpeg'
        ? `
    var prefs = app.jpegExportPreferences;
    prefs.exportResolution = ${dpi};
    prefs.jpegQuality = JPEGOptionsQuality.MAXIMUM;
    prefs.jpegExportRange = ${options.pages ? 'ExportRangeOrAllPages.EXPORT_RANGE' : 'ExportRangeOrAllPages.EXPORT_ALL'};
    prefs.exportingSpread = ${options.spreads ? 'true' : 'false'};
    prefs.useDocumentBleeds = ${options.bleed ? 'true' : 'false'};
    ${range}
    doc.exportFile(ExportFormat.JPG, File(${js(outPath)}), false);`
        : `
    var prefs = app.pngExportPreferences;
    prefs.exportResolution = ${dpi};
    prefs.pngQuality = PNGQualityEnum.MAXIMUM;
    prefs.pngColorSpace = PNGColorSpaceEnum.RGB;
    prefs.transparentBackground = false;
    prefs.pngExportRange = ${options.pages ? 'ExportRangeOrAllPages.EXPORT_RANGE' : 'ExportRangeOrAllPages.EXPORT_ALL'};
    prefs.exportingSpread = ${options.spreads ? 'true' : 'false'};
    prefs.useDocumentBleeds = ${options.bleed ? 'true' : 'false'};
    ${range}
    doc.exportFile(ExportFormat.PNG_FORMAT, File(${js(outPath)}), false);`;
  return `
(function () {
  app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
  var doc = app.open(File(${js(idmlPath)}), false);
  try {${body}
  } finally {
    doc.close(SaveOptions.NO);
  }
})();
`;
}

/** Runs an ExtendScript through the installed InDesign. */
async function runScript(install: InDesignInstall, script: string, timeout: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-script-'));
  const jsxPath = join(dir, 'run.jsx');
  writeFileSync(jsxPath, script);
  try {
    if (install.platform === 'darwin') {
      const apple = `tell application id "com.adobe.InDesign"\n do script (POSIX file ${JSON.stringify(jsxPath)}) language javascript\nend tell`;
      const r = await runCommand('osascript', ['-e', apple], timeout);
      if (r.code !== 0) throw new Error(`osascript failed: ${r.stderr.trim() || r.stdout.trim()}`);
    } else {
      const vbs = `Set app = CreateObject("InDesign.Application")\napp.DoScript ${JSON.stringify(jsxPath).replace(/\\\\/g, '\\')}, 1246973031\n`;
      const vbsPath = join(dir, 'run.vbs');
      writeFileSync(vbsPath, vbs);
      const r = await runCommand('cscript', ['//nologo', vbsPath], timeout);
      if (r.code !== 0) throw new Error(`cscript failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Exports the document to PDF/JPEG/PNG through the installed InDesign, for output identical to
 * what a designer gets from File > Export. Throws when InDesign is unavailable.
 */
export async function exportWithInDesign(
  idmlPath: string,
  outPath: string,
  format: 'pdf' | 'jpeg' | 'png',
  options: {
    pages?: string;
    dpi?: number;
    quality?: number;
    spreads?: boolean;
    bleed?: boolean;
    marks?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<{ app: string; files: string[] }> {
  const install = detectInDesign();
  if (!install) throw new Error('Adobe InDesign is not installed on this computer');
  const dir = dirname(outPath);
  const base = basename(outPath, extname(outPath));
  const ext = extname(outPath);
  // Image formats give one file per page: InDesign writes "doc.png", "doc2.png", "doc3.png".
  // Note what is already there so a re-export does not report leftovers from an earlier run.
  const before = new Map<string, number>();
  for (const f of existingSiblings(dir, base, ext)) {
    try {
      before.set(f, statSync(f).mtimeMs);
    } catch {
      // vanished between listing and stat
    }
  }
  await runScript(
    install,
    fileExportScript(idmlPath, outPath, format, options),
    options.timeoutMs ?? 180_000,
  );
  const files = existingSiblings(dir, base, ext).filter((f) => {
    // The named target belongs to this export whenever it is there at all.
    if (f === outPath) return true;
    const previous = before.get(f);
    if (previous === undefined) return true;
    try {
      return statSync(f).mtimeMs !== previous;
    } catch {
      return false;
    }
  });
  if (!files.length) throw new Error('InDesign produced no file');
  return { app: install.name, files: files.sort(comparePageOrder) };
}

/** Files InDesign could have written for `base` + `ext` in `dir`, e.g. doc.png, doc2.png. */
function existingSiblings(dir: string, base: string, ext: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(ext) && /^\d*$/.test(basename(f, ext).slice(base.length)))
    .filter((f) => basename(f, ext).startsWith(base))
    .map((f) => join(dir, f));
}

/** "doc.png" before "doc2.png" before "doc10.png". */
function comparePageOrder(a: string, b: string): number {
  const n = (p: string) => Number(/(\d*)$/.exec(basename(p, extname(p)))?.[1] || '1');
  return n(a) - n(b) || a.localeCompare(b);
}
