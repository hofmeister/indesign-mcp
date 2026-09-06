// Optional pixel-exact renderer: if Adobe InDesign is installed on this computer, drive it through
// its scripting interface to open the IDML and export pages as PNG. Never required.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';

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
  var doc = app.open(File(${js(idmlPath)}), false);
  try {
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
      prefs.pageString = p.name;
      doc.exportFile(ExportFormat.PNG_FORMAT, File(${js(outDir)} + "/page-" + pages[i] + ".png"), false);
    }
  } finally {
    doc.close(SaveOptions.NO);
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

export interface InDesignRenderResult {
  pngs: Map<number, Uint8Array>;
  app: string;
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
    return { pngs, app: install.name };
  } finally {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/** ExtendScript that exports a document as PDF, JPEG or PNG. */
function fileExportScript(
  idmlPath: string,
  outPath: string,
  format: 'pdf' | 'jpeg' | 'png',
  options: { pages?: string; dpi?: number; quality?: number; spreads?: boolean; bleed?: boolean },
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
    prefs.useDocumentBleedWithPDF = ${options.bleed ? 'true' : 'false'};
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
    timeoutMs?: number;
  } = {},
): Promise<{ app: string; files: string[] }> {
  const install = detectInDesign();
  if (!install) throw new Error('Adobe InDesign is not installed on this computer');
  await runScript(
    install,
    fileExportScript(idmlPath, outPath, format, options),
    options.timeoutMs ?? 180_000,
  );
  const dir = dirname(outPath);
  const base = basename(outPath, extname(outPath));
  const files = existsSync(outPath)
    ? [outPath]
    : readdirSync(dir)
        .filter((f) => f.startsWith(base) && f.endsWith(extname(outPath)))
        .map((f) => join(dir, f));
  if (!files.length) throw new Error('InDesign produced no file');
  return { app: install.name, files };
}
