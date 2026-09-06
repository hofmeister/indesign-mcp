import * as z from 'zod';
import { findItem } from '../idml/items.ts';
import { listPages } from '../idml/pages.ts';
import { detectInDesign } from '../preview/indesign.ts';
import {
  type PreviewOptions,
  type PreviewResult,
  previewDocument,
  previewItem,
  previewPage,
  previewSpread,
} from '../preview/index.ts';
import type { ToolContext } from './context.ts';
import type { ToolRegistry } from './registry.ts';
import { documentParam, itemParam, pageParam, run, type ToolResult, toolInput } from './shared.ts';

const previewParams = {
  width: z.number().int().min(200).max(4000).optional().describe('Image width in pixels (default 1200).'),
  renderer: z
    .enum(['auto', 'builtin', 'indesign'])
    .optional()
    .describe(
      'auto (default): use Adobe InDesign for a pixel-exact render if it is installed, otherwise the built-in renderer; builtin: always the built-in renderer; indesign: require InDesign.',
    ),
  showGuides: z.boolean().optional().describe('Draw margin and column guides.'),
  showFrameEdges: z.boolean().optional().describe('Outline text and picture frames.'),
  bleed: z.boolean().optional().describe('Include the bleed area.'),
  save: z
    .boolean()
    .optional()
    .describe('Also write the PNG next to the document, in a .previews folder (default true).'),
};

function describeResult(r: PreviewResult, what: string): string {
  const lines = [
    `${what} rendered with ${r.renderer === 'indesign' ? 'Adobe InDesign (exact)' : 'the built-in renderer (close approximation)'}, ${r.width}×${r.height} px${r.savedTo ? `, saved to ${r.savedTo}` : ''}.`,
  ];
  const subs = Object.entries(r.substitutions);
  if (subs.length)
    lines.push(
      `Font substitutions in this preview (not in the document): ${subs.map(([k, v]) => `${k} → ${v}`).join('; ')}.`,
    );
  if (r.warnings.length)
    lines.push(`Notes: ${r.warnings.slice(0, 8).join('; ')}${r.warnings.length > 8 ? '; …' : ''}`);
  return lines.join('\n');
}

function imageResult(r: PreviewResult, text: string, structured: Record<string, unknown>): ToolResult {
  const result: ToolResult = {
    content: [
      { type: 'text', text },
      { type: 'image', data: Buffer.from(r.png).toString('base64'), mimeType: 'image/png' } as unknown as {
        type: 'text';
        text: string;
      },
    ],
    structuredContent: structured,
  };
  return result;
}

export function registerPreviewTools(reg: ToolRegistry, ctx: ToolContext): void {
  const opts = (args: {
    width?: number;
    renderer?: 'auto' | 'builtin' | 'indesign';
    showGuides?: boolean;
    showFrameEdges?: boolean;
    bleed?: boolean;
    save?: boolean;
  }): PreviewOptions => ({
    width: args.width,
    renderer: args.renderer,
    showGuides: args.showGuides,
    showFrameEdges: args.showFrameEdges,
    bleed: args.bleed,
    save: args.save,
  });

  reg.variant(
    'preview',
    'page',
    {
      title: 'Preview page',
      description:
        'Renders a page to a PNG image and shows it, so you can check the layout. Uses Adobe InDesign itself when installed (exact), otherwise a built-in renderer with real fonts (very close: frames, colours, pictures and text positions match; fine typographic details may differ). Also saves the PNG next to the document.',
      inputSchema: toolInput({ document: documentParam, page: pageParam.default(1), ...previewParams }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run(async () => {
        const doc = ctx.open(args.document);
        const r = await previewPage(doc, args.page, opts(args));
        return imageResult(r, describeResult(r, `Page ${args.page}`), {
          renderer: r.renderer,
          width: r.width,
          height: r.height,
          savedTo: r.savedTo,
          warnings: r.warnings,
          substitutions: r.substitutions,
        });
      }),
  );

  reg.variant(
    'preview',
    'spread',
    {
      title: 'Preview spread',
      description: 'Renders the whole spread (facing pages side by side) that contains the given page.',
      inputSchema: toolInput({ document: documentParam, page: pageParam.default(1), ...previewParams }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run(async () => {
        const doc = ctx.open(args.document);
        const r = await previewSpread(doc, args.page, opts(args));
        return imageResult(r, describeResult(r, `Spread with page ${args.page}`), {
          renderer: r.renderer,
          width: r.width,
          height: r.height,
          savedTo: r.savedTo,
          warnings: r.warnings,
        });
      }),
  );

  reg.variant(
    'preview',
    'document',
    {
      title: 'Preview all pages',
      description: 'Renders every page as a thumbnail on one contact sheet.',
      inputSchema: toolInput({
        document: documentParam,
        width: z.number().int().min(400).max(4000).optional(),
        columns: z.number().int().min(1).max(8).optional(),
        showGuides: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run(async () => {
        const doc = ctx.open(args.document);
        const r = await previewDocument(doc, {
          width: args.width,
          columns: args.columns,
          showGuides: args.showGuides,
        });
        return imageResult(r, describeResult(r, `${listPages(doc).length} page(s)`), {
          renderer: r.renderer,
          width: r.width,
          height: r.height,
          savedTo: r.savedTo,
          warnings: r.warnings,
        });
      }),
  );

  reg.variant(
    'preview',
    'item',
    {
      title: 'Preview item (zoomed)',
      description: 'Renders a close-up of one item and its surroundings.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        width: z.number().int().min(200).max(4000).optional(),
        showFrameEdges: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run(async () => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        if (found.info.page === undefined || !found.info.bounds)
          throw new Error('The item is not on a document page');
        const r = await previewItem(doc, found.info.page, found.info.bounds, {
          width: args.width,
          showFrameEdges: args.showFrameEdges,
        });
        return imageResult(
          r,
          describeResult(r, `${found.info.type} ${found.info.name ? `"${found.info.name}"` : found.info.id}`),
          { renderer: r.renderer, width: r.width, height: r.height, warnings: r.warnings },
        );
      }),
  );

  reg.tool(
    'preview_capabilities',
    {
      title: 'Preview capabilities',
      description:
        'Reports whether Adobe InDesign is available for exact previews and which fonts the built-in renderer can use.',
      inputSchema: toolInput({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const { fontCatalog } = await import('../preview/fonts.ts');
        const install = detectInDesign();
        const families = fontCatalog().families();
        const text = [
          install
            ? `Adobe InDesign detected (${install.name}): previews can be pixel-exact.`
            : 'Adobe InDesign not detected: previews use the built-in renderer.',
          `${families.length} font families available for previews${families.length ? `, e.g. ${families.slice(0, 15).join(', ')}${families.length > 15 ? ', …' : ''}` : ''}.`,
        ].join('\n');
        return {
          content: [{ type: 'text', text }],
          structuredContent: { indesign: install?.name, fontFamilies: families },
        };
      }),
  );
}
