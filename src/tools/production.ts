import { basename, dirname, join, resolve } from 'node:path';
import * as z from 'zod';
import { exportDocument } from '../export/index.ts';
import { listMergeFields, mergeRecords, mergeToDocuments, readDataSource } from '../idml/datamerge.ts';
import {
  embedGraphic,
  findGraphic,
  graphicHits,
  linkRecord,
  listLinks,
  relinkGraphic,
  unembedGraphic,
} from '../idml/links.ts';
import { packageDocument } from '../idml/packaging.ts';
import { preflight, preflightToMarkdown } from '../idml/preflight.ts';
import type { ToolContext } from './context.ts';
import type { ToolRegistry } from './registry.ts';
import { documentParam, ok, pageParam, run, toolInput } from './shared.ts';

const fitParam = z
  .enum(['fill', 'fit', 'stretch', 'center', 'frame-to-content'])
  .describe('How the picture sits in its frame; fill (default) crops to fill it.');

export function registerProductionTools(reg: ToolRegistry, ctx: ToolContext): void {
  reg.tool(
    'list_links',
    {
      title: 'List placed images',
      description:
        'Lists every placed picture with its file, page, print resolution and whether the file is still there — InDesign’s Links panel.',
      inputSchema: toolInput({ document: documentParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(() => {
        const links = listLinks(ctx.open(document));
        if (!links.length) return ok('This document has no placed images.', { links: [] });
        const lines = links.map(
          (l) =>
            `${l.fileName}${l.page ? ` (page ${l.page})` : l.onMaster ? ` (master ${l.onMaster})` : ''} — ${l.widthPx}×${l.heightPx} px at ${l.effectivePpi} ppi, ${l.scalePercent}%${l.status === 'ok' ? '' : ` — ${l.status.toUpperCase()}`}`,
        );
        return ok(lines.join('\n'), { links });
      }),
  );

  reg.tool(
    'relink_image',
    {
      title: 'Relink a picture',
      description:
        'Points a placed picture at a different file, keeping the frame, its position and its fitting. Also fixes a missing link.',
      inputSchema: toolInput({
        document: documentParam,
        image: z
          .string()
          .describe('Which picture: the frame name or id, or the current file name (see list_links).'),
        newFile: z.string().describe('Path of the image file to link to.'),
        fit: fitParam.optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const hit = findGraphic(doc, args.image);
        const r = relinkGraphic(doc, hit, ctx.resolvePath(args.newFile, { mustExist: true }), {
          fit: args.fit,
        });
        ctx.save(doc);
        return ok(
          `Relinked to ${basename(r.to)} (${r.widthPx}×${r.heightPx} px, ${r.effectivePpi} ppi in the frame).`,
          { ...r },
        );
      }),
  );

  reg.tool(
    'embed_images',
    {
      title: 'Embed pictures in the document',
      description:
        'Copies picture files into the document so it can be sent on its own. The file grows; use unembed_images or package_document if you would rather keep the pictures as separate files.',
      inputSchema: toolInput({
        document: documentParam,
        image: z.string().optional().describe('One picture (frame name, id or file name). Omit for all.'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const targets = args.image ? [findGraphic(doc, args.image)] : graphicHits(doc);
        const done: string[] = [];
        const skipped: string[] = [];
        for (const hit of targets) {
          const rec = linkRecord(hit);
          if (rec.embedded || !rec.exists) {
            skipped.push(`${rec.fileName} (${rec.embedded ? 'already embedded' : 'file missing'})`);
            continue;
          }
          const r = embedGraphic(doc, hit);
          done.push(`${r.fileName} (${Math.round(r.bytes / 1024)} kB)`);
        }
        ctx.save(doc);
        return ok(
          `Embedded ${done.length} picture(s)${done.length ? `: ${done.join(', ')}` : ''}.${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}`,
          { embedded: done, skipped },
        );
      }),
  );

  reg.tool(
    'unembed_images',
    {
      title: 'Save embedded pictures back to files',
      description:
        'Writes embedded pictures into a Links folder next to the document and links to them again.',
      inputSchema: toolInput({
        document: documentParam,
        image: z.string().optional().describe('One picture. Omit for all embedded pictures.'),
        folder: z
          .string()
          .optional()
          .describe('Where to write them (default: a Links folder next to the document).'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const path = ctx.resolvePath(args.document, { mustExist: true });
        const dir = args.folder ? ctx.resolvePath(args.folder) : ctx.linksDir(path);
        const targets = (args.image ? [findGraphic(doc, args.image)] : graphicHits(doc)).filter(
          (h) => linkRecord(h).embedded,
        );
        const written: string[] = [];
        for (const hit of targets) written.push(unembedGraphic(doc, hit, dir).path);
        ctx.save(doc);
        return ok(
          written.length
            ? `Wrote ${written.length} picture(s) to ${dir} and relinked them.`
            : 'No embedded pictures found.',
          { files: written, folder: dir },
        );
      }),
  );

  reg.tool(
    'preflight_document',
    {
      title: 'Preflight (check before printing)',
      description:
        'Checks the document the way InDesign’s Preflight panel does: overset text, missing or low-resolution pictures, missing fonts, RGB colours in print work, hairlines, objects running off the page without bleed and empty frames.',
      inputSchema: toolInput({
        document: documentParam,
        intent: z
          .enum(['print', 'screen'])
          .optional()
          .describe('print (default) checks CMYK and resolution; screen is more relaxed.'),
        minPpi: z
          .number()
          .int()
          .min(30)
          .max(1200)
          .optional()
          .describe('Minimum picture resolution (default 250 for print).'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run(() => {
        const report = preflight(ctx.open(args.document), {
          intent: args.intent,
          minPpi: args.minPpi,
        });
        return ok(preflightToMarkdown(report), {
          ok: report.ok,
          errors: report.errors,
          warnings: report.warnings,
          issues: report.issues,
        });
      }),
  );

  reg.tool(
    'package_document',
    {
      title: 'Package for a printer or client',
      description:
        'Collects the document, copies of every linked picture and a font/preflight report into one folder, ready to hand over — InDesign’s File > Package.',
      inputSchema: toolInput({
        document: documentParam,
        folder: z.string().describe('Folder to create the package in.'),
        copyFonts: z
          .boolean()
          .optional()
          .describe('Also copy the font files used (check your font licence first). Default false.'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const folder = ctx.resolvePath(args.folder);
        const r = packageDocument(doc, { folder, copyFonts: args.copyFonts });
        const lines = [
          `Packaged to ${r.folder}: the document, ${r.links.filter((l) => l.copied).length} picture(s) in Links/ and a report.`,
        ];
        if (r.missingLinks)
          lines.push(`${r.missingLinks} picture(s) could not be copied — the files are missing.`);
        if (r.missingFonts)
          lines.push(
            `${r.missingFonts} font(s) are not installed here: ${r.fonts
              .filter((f) => !f.installed)
              .map((f) => f.family)
              .join(', ')}.`,
          );
        return ok(lines.join('\n'), {
          folder: r.folder,
          document: r.document,
          links: r.links,
          fonts: r.fonts,
          report: r.reportPath,
          sizeKb: Math.round(r.totalBytes / 1024),
        });
      }),
  );

  reg.tool(
    'list_merge_fields',
    {
      title: 'List data-merge placeholders',
      description:
        'Shows the <<Field>> placeholders in the document — in text, and as picture-frame names — so you know what columns the data file needs.',
      inputSchema: toolInput({ document: documentParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(() => {
        const fields = listMergeFields(ctx.open(document));
        const text = [
          fields.text.length
            ? `Text placeholders: ${fields.text.map((f) => `<<${f}>>`).join(', ')}`
            : 'No text placeholders.',
          fields.images.length
            ? `Picture placeholders (frame names): ${fields.images.map((f) => `<<${f}>>`).join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        return ok(text, fields);
      }),
  );

  reg.tool(
    'data_merge',
    {
      title: 'Data merge (fill from a spreadsheet)',
      description:
        'Fills a template page once per row of a CSV or JSON file, adding a page for every row — for name badges, certificates, price lists or personalised letters. Write <<Field>> in the text; name a picture frame <<Field>> to place a picture whose path is in that column.',
      inputSchema: toolInput({
        document: documentParam,
        dataFile: z
          .string()
          .describe('Path to a .csv, .tsv or .json file. The first CSV row holds the column names.'),
        templatePage: pageParam.optional().describe('Page holding the placeholders (default 1).'),
        separateDocuments: z
          .boolean()
          .optional()
          .describe('Write one document per row instead of adding pages (default false).'),
        outputFolder: z.string().optional().describe('Where to write the separate documents.'),
        nameFrom: z.string().optional().describe('Column to name the separate documents after.'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Only merge the first N rows (useful for a test run).'),
        fit: fitParam.optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const dataPath = ctx.resolvePath(args.dataFile, { mustExist: true });
        const data = readDataSource(dataPath);
        const options = {
          templatePage: args.templatePage,
          imageBase: dirname(dataPath),
          fit: args.fit,
          limit: args.limit,
        };
        if (args.separateDocuments) {
          const docPath = ctx.resolvePath(args.document, { mustExist: true });
          const outDir = args.outputFolder
            ? ctx.resolvePath(args.outputFolder)
            : join(dirname(docPath), `${basename(docPath, '.idml')} merged`);
          const base = basename(docPath, '.idml');
          const { paths, result } = mergeToDocuments(
            doc,
            data,
            outDir,
            (record, i) => {
              const raw = args.nameFrom ? (record[args.nameFrom] ?? '') : '';
              const safe = raw.replace(/[^\w\-. ]+/g, '').trim();
              return safe || `${base}-${i + 1}`;
            },
            options,
          );
          return ok(
            `Wrote ${paths.length} document(s) to ${resolve(outDir)}.${result.missingFields.length ? ` Fields with no column: ${result.missingFields.join(', ')}.` : ''}`,
            { files: paths, ...result },
          );
        }
        const r = mergeRecords(doc, data, options);
        ctx.save(doc);
        const notes = [
          `Merged ${r.records} record(s) onto ${r.pages.length} page(s)${r.imagesPlaced ? `, placed ${r.imagesPlaced} picture(s)` : ''}.`,
        ];
        if (r.missingFields.length) notes.push(`No column for: ${r.missingFields.join(', ')} (left empty).`);
        if (r.missingImages.length) notes.push(`Pictures not found: ${r.missingImages.join(', ')}.`);
        return ok(notes.join(' '), { ...r });
      }),
  );

  reg.tool(
    'export_document',
    {
      title: 'Export as PDF, JPEG or PNG',
      description:
        'Exports the document for sending or printing. With Adobe InDesign installed the export is done by InDesign itself (press-ready PDF); otherwise the built-in renderer writes a vector PDF or images that are very close but not colour-managed.',
      inputSchema: toolInput({
        document: documentParam,
        format: z.enum(['pdf', 'png', 'jpeg']).describe('pdf for sending or printing, png/jpeg for the web.'),
        outputFile: z
          .string()
          .optional()
          .describe(
            'Where to write it (default: next to the document). Several pages become file-1, file-2, …',
          ),
        pages: z
          .array(z.union([z.number().int().positive(), z.string()]))
          .optional()
          .describe('Pages to export, e.g. [1,2] or ["1-4"]. All pages by default.'),
        spreads: z.boolean().optional().describe('Export facing pages together as spreads.'),
        dpi: z.number().int().min(36).max(1200).optional().describe('Resolution for PNG/JPEG (default 150).'),
        quality: z.number().int().min(1).max(100).optional().describe('JPEG quality (default 90).'),
        bleed: z.boolean().optional().describe('Include the bleed area.'),
        marks: z
          .boolean()
          .optional()
          .describe(
            "Printer's marks on a PDF: crop and bleed marks, registration, colour bars and page info. Needs Adobe InDesign; the built-in renderer cannot draw them.",
          ),
        renderer: z.enum(['auto', 'builtin', 'indesign']).optional(),
      }),
    },
    async (args) =>
      run(async () => {
        const doc = ctx.open(args.document);
        const docPath = ctx.resolvePath(args.document, { mustExist: true });
        const target = args.outputFile
          ? ctx.resolvePath(args.outputFile)
          : join(dirname(docPath), basename(docPath, '.idml'));
        const r = await exportDocument(doc, {
          format: args.format,
          path: target,
          pages: args.pages,
          spreads: args.spreads,
          dpi: args.dpi,
          quality: args.quality,
          bleed: args.bleed,
          marks: args.marks,
          renderer: args.renderer,
        });
        const lines = [
          `Exported ${r.files.length} file(s) with ${r.renderer === 'indesign' ? 'Adobe InDesign' : 'the built-in renderer'}:`,
          ...r.files.map((f) => `- ${f}`),
        ];
        if (Object.keys(r.substitutions).length)
          lines.push(
            `Font substitutions: ${Object.entries(r.substitutions)
              .map(([k, v]) => `${k} → ${v}`)
              .join('; ')}.`,
          );
        if (r.warnings.length) lines.push(...r.warnings.map((w) => `Note: ${w}`));
        return ok(lines.join('\n'), { files: r.files, renderer: r.renderer });
      }),
  );
}
