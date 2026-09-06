import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { summarizeDocument, summaryToMarkdown } from '../idml/inspect.ts';
import { validateAgainstSchema } from '../idml/schema.ts';
import { createDocument } from '../idml/template.ts';
import { PAGE_SIZES } from '../idml/units.ts';
import { summarizeIssues, validateDocument } from '../idml/validate.ts';
import type { ToolContext } from './context.ts';
import { documentParam, lengthParam, ok, run, toolInput } from './shared.ts';
export function registerDocumentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'new_document',
    {
      title: 'New document',
      description:
        'Creates a new InDesign document (.idml) from the built-in blank template: page size, orientation, number of pages, margins, columns and bleed. The file is saved immediately. Then use add_text_frame, place_image etc. to fill it.',
      inputSchema: toolInput({
        path: z
          .string()
          .describe('Where to save, e.g. "flyer.idml" (saved in the documents folder) or an absolute path.'),
        pageSize: z
          .string()
          .optional()
          .describe(
            `Preset name: ${Object.keys(PAGE_SIZES).join(', ')}. Default A4. Ignore when width/height are given.`,
          ),
        orientation: z.enum(['portrait', 'landscape']).optional(),
        width: lengthParam.optional(),
        height: lengthParam.optional(),
        pages: z.number().int().min(1).max(500).optional().describe('Number of pages (default 1).'),
        facingPages: z
          .boolean()
          .optional()
          .describe('Facing pages (spreads) like a brochure. Default false.'),
        margins: lengthParam.optional().describe('Uniform page margin (default 12.7mm).'),
        columns: z.number().int().min(1).max(20).optional(),
        gutter: lengthParam.optional(),
        bleed: lengthParam.optional().describe('Bleed on all sides, e.g. "3mm".'),
        overwrite: z.boolean().optional().describe('Overwrite an existing file. Default false.'),
      }),
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (args) =>
      run(() => {
        const path = ctx.resolvePath(args.path, { forWrite: true });
        if (!args.overwrite && require('node:fs').existsSync(path)) {
          throw new Error(
            `${path} already exists. Pass overwrite: true to replace it, or choose another name.`,
          );
        }
        const doc = createDocument({
          pageSize: args.pageSize,
          orientation: args.orientation,
          width: args.width,
          height: args.height,
          pages: args.pages,
          facingPages: args.facingPages ?? false,
          margins: args.margins ?? '12.7mm',
          columns: args.columns,
          gutter: args.gutter,
          bleed: args.bleed,
          unit: ctx.unit,
        });
        ctx.adopt(doc, path);
        const summary = summarizeDocument(doc, ctx.unit);
        return ok(
          `Created ${path}: ${summary.pageCount} page(s), ${summary.pageSize.width} × ${summary.pageSize.height}${summary.facingPages ? ', facing pages' : ''}.`,
          {
            path,
            pages: summary.pageCount,
            pageSize: summary.pageSize,
          },
        );
      }),
  );

  server.registerTool(
    'open_document',
    {
      title: 'Open document',
      description:
        'Opens an existing .idml file and returns a summary of its pages, items, styles and swatches (same as describe_document).',
      inputSchema: toolInput({ document: documentParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(() => {
        const doc = ctx.open(document);
        const summary = summarizeDocument(doc, ctx.unit);
        return ok(summaryToMarkdown(summary), summary as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    'describe_document',
    {
      title: 'Describe document',
      description:
        'Describes a document: pages with every item (type, name, id, position and size in mm, text, images), master pages, layers, paragraph/character styles, swatches and fonts. Call this before editing so you can refer to items by name or id.',
      inputSchema: toolInput({
        document: documentParam,
        page: z
          .union([z.number().int().positive(), z.string()])
          .optional()
          .describe('Only describe this page.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ document, page }) =>
      run(() => {
        const doc = ctx.open(document);
        const summary = summarizeDocument(doc, ctx.unit);
        if (page !== undefined) {
          const n = typeof page === 'number' ? page : Number(page);
          summary.pages = summary.pages.filter((p) => p.number === n || p.name === String(page));
        }
        return ok(summaryToMarkdown(summary), summary as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    'validate_document',
    {
      title: 'Validate document',
      description:
        "Checks the document for problems that would stop InDesign from opening it or make it behave oddly: missing parts, duplicate ids, references to deleted styles/swatches/stories, page-count mismatches, broken text threads, and (schema: true, default) every part against Adobe's IDML schema.",
      inputSchema: toolInput({
        document: documentParam,
        schema: z
          .boolean()
          .optional()
          .describe('Also validate against the IDML RELAX NG schema (default true).'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ document, schema }) =>
      run(() => {
        const doc = ctx.open(document);
        const issues = validateDocument(doc);
        const lines = issues.map((i) => `- ${i.level.toUpperCase()} [${i.part}] ${i.message}`);
        let schemaSummary = '';
        let schemaResult: Record<string, unknown> | undefined;
        if (schema !== false) {
          const r = validateAgainstSchema(doc, { schemaDir: ctx.config.schemaDir });
          const errors = r.issues.filter((i) => i.level === 'error');
          const infos = r.issues.filter((i) => i.level === 'info');
          schemaSummary = `\nSchema check (IDML ${r.schemaVersion}, ${r.partsChecked} parts): ${errors.length} error(s)${infos.length ? `, ${infos.length} newer-version item(s)` : ''}.`;
          if (r.versionNote) schemaSummary += `\n${r.versionNote}`;
          for (const i of errors.slice(0, 40)) lines.push(`- SCHEMA [${i.part}] ${i.path}: ${i.message}`);
          if (errors.length > 40) lines.push(`- … ${errors.length - 40} more schema errors`);
          for (const i of infos.slice(0, 10)) lines.push(`- INFO [${i.part}] ${i.path}: ${i.message}`);
          schemaResult = {
            schemaVersion: r.schemaVersion,
            errors: errors.length,
            info: infos.length,
            issues: r.issues.slice(0, 200),
          };
          for (const e of errors)
            issues.push({ level: 'error', part: e.part, message: `${e.path}: ${e.message}` });
        }
        return ok(
          `${summarizeIssues(issues)}${schemaSummary}${lines.length ? `\n${lines.join('\n')}` : ''}`,
          {
            errors: issues.filter((i) => i.level === 'error').length,
            warnings: issues.filter((i) => i.level === 'warning').length,
            issues,
            schema: schemaResult,
          },
        );
      }),
  );

  server.registerTool(
    'save_document_as',
    {
      title: 'Save document as',
      description: 'Saves a copy of the document under a new name. Later edits should refer to the new path.',
      inputSchema: toolInput({
        document: documentParam,
        newPath: z.string(),
        overwrite: z.boolean().optional(),
      }),
    },
    async ({ document, newPath, overwrite }) =>
      run(() => {
        const doc = ctx.open(document);
        const target = ctx.resolvePath(newPath, { forWrite: true });
        if (!overwrite && require('node:fs').existsSync(target)) throw new Error(`${target} already exists`);
        require('node:fs').writeFileSync(target, doc.toBytes());
        return ok(`Saved a copy to ${target}`, { path: target });
      }),
  );

  server.registerTool(
    'set_document_options',
    {
      title: 'Document options',
      description:
        'Changes document-wide settings: bleed, slug, facing pages. Page size is changed with set_page_size.',
      inputSchema: toolInput({
        document: documentParam,
        bleed: lengthParam.optional(),
        slug: lengthParam.optional(),
        facingPages: z.boolean().optional(),
      }),
    },
    async ({ document, bleed, slug, facingPages }) =>
      run(() => {
        const doc = ctx.open(document);
        const dp = doc.resource('Preferences').getElementsByTagName('DocumentPreference')[0];
        if (!dp) throw new Error('DocumentPreference missing');
        if (bleed !== undefined) {
          const b = ctx.pt(bleed);
          for (const a of [
            'DocumentBleedTopOffset',
            'DocumentBleedBottomOffset',
            'DocumentBleedInsideOrLeftOffset',
            'DocumentBleedOutsideOrRightOffset',
          ])
            dp.setAttribute(a, String(b));
          dp.setAttribute('DocumentBleedUniformSize', 'true');
        }
        if (slug !== undefined) {
          const s = ctx.pt(slug);
          for (const a of [
            'SlugTopOffset',
            'SlugBottomOffset',
            'SlugInsideOrLeftOffset',
            'SlugRightOrOutsideOffset',
          ])
            dp.setAttribute(a, String(s));
          dp.setAttribute('DocumentSlugUniformSize', 'true');
        }
        if (facingPages !== undefined) dp.setAttribute('FacingPages', facingPages ? 'true' : 'false');
        ctx.save(doc);
        return ok('Document options updated.');
      }),
  );
}
