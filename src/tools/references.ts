import { existsSync, writeFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { summarizeDocument, summaryToMarkdown } from '../idml/inspect.ts';
import { createDocument } from '../idml/template.ts';
import type { ReferenceCatalog } from '../references/catalog.ts';
import { copyMaster, copyPage, type ImportReport, importStyles } from '../references/importer.ts';
import type { ToolContext } from './context.ts';
import { documentParam, lengthParam, ok, pageParam, run } from './shared.ts';

function reportText(r: ImportReport): string {
  const parts: string[] = [];
  if (r.paragraphStyles.length) parts.push(`paragraph styles: ${r.paragraphStyles.join(', ')}`);
  if (r.characterStyles.length) parts.push(`character styles: ${r.characterStyles.join(', ')}`);
  if (r.objectStyles.length) parts.push(`object styles: ${r.objectStyles.join(', ')}`);
  if (r.swatches.length) parts.push(`swatches: ${r.swatches.join(', ')}`);
  if (r.fonts.length) parts.push(`fonts: ${r.fonts.join(', ')}`);
  if (r.skipped.length) parts.push(`skipped: ${r.skipped.join('; ')}`);
  if (r.warnings.length) parts.push(`warnings: ${r.warnings.join('; ')}`);
  return parts.length ? parts.join('\n') : 'Nothing to import.';
}

export function registerReferenceTools(server: McpServer, ctx: ToolContext, catalog: ReferenceCatalog): void {
  server.registerTool(
    'list_reference_documents',
    {
      title: 'List reference documents',
      description:
        'Lists the reference InDesign documents available (bundled with the server and from configured folders). Use them to reuse styles, swatches, master pages or whole pages instead of designing from scratch.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(() => {
        const refs = catalog.list().map((r) => {
          const { summary } = catalog.summary(r.name, ctx.unit);
          return {
            name: r.name,
            source: r.source,
            path: r.source === 'folder' ? r.path : undefined,
            pages: summary.pageCount,
            pageSize: `${summary.pageSize.width} × ${summary.pageSize.height}`,
            paragraphStyles: summary.paragraphStyles.length,
            masters: summary.masters.map((m) => m.name),
          };
        });
        return ok(
          refs
            .map(
              (r) =>
                `- ${r.name} (${r.source}): ${r.pages} page(s) ${r.pageSize}, ${r.paragraphStyles} paragraph styles, masters: ${r.masters.join(', ') || 'none'}`,
            )
            .join('\n') ||
            'No reference documents. Add .idml files to a folder and use add_reference_folder.',
          { references: refs, folders: catalog.listFolders() },
        );
      }),
  );

  server.registerTool(
    'describe_reference',
    {
      title: 'Describe reference document',
      description:
        'Full description of a reference document: pages and items, master pages, styles (with fonts and sizes), swatches and fonts.',
      inputSchema: z.object({
        reference: z
          .string()
          .describe('Reference name (from list_reference_documents) or a path to an .idml file.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ reference }) =>
      run(() => {
        const { summary } = catalog.summary(reference, ctx.unit);
        return ok(summaryToMarkdown(summary), summary as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    'add_reference_folder',
    {
      title: 'Add reference folder',
      description: 'Registers a folder of .idml files as references for this session.',
      inputSchema: z.object({ folder: z.string() }),
    },
    async ({ folder }) =>
      run(() => {
        const r = catalog.addFolder(ctx.resolvePath(folder));
        return ok(`${r.added ? 'Added' : 'Already registered'}: ${folder} (${r.count} .idml file(s)).`, r);
      }),
  );

  server.registerTool(
    'new_document_from_reference',
    {
      title: 'New document from reference',
      description:
        'Starts a new document from a reference: either a full copy (keepContent true) or its styles, swatches, masters and page setup with empty pages (default).',
      inputSchema: z.object({
        reference: z.string(),
        path: z.string().describe('Where to save the new document.'),
        keepContent: z
          .boolean()
          .optional()
          .describe("Keep the reference's pages and content (default false = empty pages, same setup)."),
        pages: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Number of pages when not keeping content (default 1).'),
        pageSize: z.string().optional(),
        orientation: z.enum(['portrait', 'landscape']).optional(),
        width: lengthParam.optional(),
        height: lengthParam.optional(),
        overwrite: z.boolean().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const path = ctx.resolvePath(args.path, { forWrite: true });
        if (!args.overwrite && existsSync(path))
          throw new Error(`${path} already exists. Pass overwrite: true or choose another name.`);
        const entry = catalog.find(args.reference);
        const bytes = catalog.bytes(entry);
        if (args.keepContent) {
          writeFileSync(path, bytes);
          ctx.forget(path);
          const doc = ctx.open(path);
          const s = summarizeDocument(doc, ctx.unit);
          return ok(`Created ${path} as a copy of ${entry.name} (${s.pageCount} page(s)).`, {
            path,
            pages: s.pageCount,
          });
        }
        const doc = createDocument({
          templateBytes: bytes,
          keepContent: false,
          pages: args.pages,
          pageSize: args.pageSize,
          orientation: args.orientation,
          width: args.width,
          height: args.height,
          unit: ctx.unit,
        });
        ctx.adopt(doc, path);
        const s = summarizeDocument(doc, ctx.unit);
        return ok(
          `Created ${path} from ${entry.name}: ${s.pageCount} empty page(s) ${s.pageSize.width} × ${s.pageSize.height}, with its ${s.paragraphStyles.length} paragraph styles, ${s.swatches.length} swatches and masters ${s.masters.map((m) => m.name).join(', ') || 'none'}.`,
          { path, pages: s.pageCount },
        );
      }),
  );

  server.registerTool(
    'import_styles_from_reference',
    {
      title: 'Import styles from reference',
      description:
        'Copies paragraph/character/object styles, swatches and fonts from a reference document into the current document. By default everything; limit with the flags or `only` names.',
      inputSchema: z.object({
        document: documentParam,
        reference: z.string(),
        paragraph: z.boolean().optional(),
        character: z.boolean().optional(),
        object: z.boolean().optional(),
        swatches: z.boolean().optional(),
        fonts: z.boolean().optional(),
        only: z.array(z.string()).optional().describe('Only these style/swatch names.'),
        conflict: z
          .enum(['skip', 'overwrite', 'rename'])
          .optional()
          .describe('What to do when a style with the same name exists (default skip).'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { doc: from, entry } = catalog.load(args.reference);
        const report = importStyles(from, doc, {
          paragraph: args.paragraph,
          character: args.character,
          object: args.object,
          swatches: args.swatches,
          fonts: args.fonts,
          only: args.only,
          conflict: args.conflict,
        });
        ctx.save(doc);
        return ok(
          `Imported from ${entry.name}:\n${reportText(report)}`,
          report as unknown as Record<string, unknown>,
        );
      }),
  );

  server.registerTool(
    'copy_master_from_reference',
    {
      title: 'Copy master page from reference',
      description:
        'Copies a master page (with its items, styles and swatches) from a reference document into the current document.',
      inputSchema: z.object({
        document: documentParam,
        reference: z.string(),
        master: z.string().describe('Master name in the reference, e.g. "A-Master".'),
        prefix: z.string().max(4).optional(),
        name: z.string().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { doc: from, entry } = catalog.load(args.reference);
        const r = copyMaster(from, doc, args.master, { prefix: args.prefix, name: args.name });
        ctx.save(doc);
        return ok(
          `Copied master ${args.master} from ${entry.name} as ${r.name} [${r.id}].\n${reportText(r.report)}`,
          { id: r.id, name: r.name, report: r.report },
        );
      }),
  );

  server.registerTool(
    'copy_page_from_reference',
    {
      title: 'Copy page from reference',
      description:
        'Copies everything on a reference page onto a new page at the end of the current document (or onto an existing page), including the styles, swatches and master it needs. Linked images stay linked to their original files.',
      inputSchema: z.object({
        document: documentParam,
        reference: z.string(),
        page: pageParam.describe('Page in the reference.'),
        ontoPage: pageParam.optional().describe('Existing page to copy onto (default: a new page).'),
        applyMaster: z.boolean().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { doc: from, entry } = catalog.load(args.reference);
        const r = copyPage(from, doc, args.page, { ontoPage: args.ontoPage, applyMaster: args.applyMaster });
        ctx.save(doc);
        return ok(
          `Copied ${r.items} item(s) from page ${args.page} of ${entry.name} onto page ${r.page.index}.\n${reportText(r.report)}`,
          { page: r.page.index, items: r.items, report: r.report },
        );
      }),
  );

  // Resources: reference summaries
  server.registerResource(
    'reference-document',
    new ResourceTemplate('reference://{name}', {
      list: () => ({
        resources: catalog.list().map((r) => ({
          uri: `reference://${encodeURIComponent(r.name)}`,
          name: r.name,
          description: `Reference InDesign document (${r.source})`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      title: 'Reference documents',
      description: 'Summaries of the available reference InDesign documents.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const name = decodeURIComponent(String(variables.name ?? ''));
      const { summary } = catalog.summary(name, ctx.unit);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: summaryToMarkdown(summary) }] };
    },
  );
}
