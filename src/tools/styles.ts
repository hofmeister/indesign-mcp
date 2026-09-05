import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
  applyStyleSpec,
  createCharacterStyle,
  createParagraphStyle,
  createSwatch,
  deleteStyle,
  listFonts,
  listStyles,
  listSwatches,
  parseColorString,
  resolveStyle,
} from '../idml/styles.ts';
import type { ToolContext } from './context.ts';
import { colorParam, documentParam, ok, run } from './shared.ts';

const textStyleFields = {
  font: z
    .string()
    .optional()
    .describe('Font family, e.g. "Helvetica Neue". Must be installed on the designer\'s computer.'),
  fontStyle: z.string().optional().describe('Font style name: Regular, Bold, Italic, Light, Semibold…'),
  size: z.number().positive().optional().describe('Point size.'),
  leading: z
    .union([z.number().positive(), z.literal('auto')])
    .optional()
    .describe('Line spacing in points, or "auto".'),
  color: colorParam.optional(),
  tracking: z.number().optional(),
  capitalization: z.enum(['normal', 'small-caps', 'all-caps', 'cap-to-small-cap']).optional(),
  underline: z.boolean().optional(),
  strikeThrough: z.boolean().optional(),
  position: z.enum(['normal', 'superscript', 'subscript']).optional(),
  horizontalScale: z.number().optional(),
  baselineShift: z.number().optional(),
};

const paragraphFields = {
  alignment: z
    .enum([
      'left',
      'center',
      'right',
      'justify',
      'justify-all',
      'justify-center',
      'justify-right',
      'to-binding',
      'away-from-binding',
    ])
    .optional(),
  spaceBefore: z.number().min(0).optional().describe('Points.'),
  spaceAfter: z.number().min(0).optional(),
  leftIndent: z.number().min(0).optional(),
  rightIndent: z.number().min(0).optional(),
  firstLineIndent: z.number().optional(),
  hyphenate: z.boolean().optional(),
  keepLinesTogether: z.boolean().optional(),
  dropCapLines: z.number().int().min(0).optional(),
  dropCapCharacters: z.number().int().min(0).optional(),
};

export function registerStyleTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_styles',
    {
      title: 'List styles',
      description: 'Lists paragraph, character and object styles with their main settings.',
      inputSchema: z.object({
        document: documentParam,
        kind: z.enum(['paragraph', 'character', 'object', 'all']).default('all'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ document, kind }) =>
      run(() => {
        const doc = ctx.open(document);
        const out: Record<string, unknown> = {};
        const lines: string[] = [];
        const add = (label: string, k: 'ParagraphStyle' | 'CharacterStyle' | 'ObjectStyle') => {
          const styles = listStyles(doc, k);
          out[label] = styles;
          lines.push(`## ${label}`);
          for (const s of styles) {
            const bits = [
              s.font,
              s.fontStyle,
              s.pointSize ? `${s.pointSize}pt` : undefined,
              s.leading ? `leading ${s.leading}` : undefined,
              s.alignment,
              s.fillColor?.replace(/^Color\//, ''),
              s.basedOn ? `based on ${s.basedOn.replace(/^\$ID\//, '')}` : undefined,
            ].filter(Boolean);
            lines.push(
              `- ${s.group ? `${s.group}/` : ''}${s.name}${bits.length ? ` (${bits.join(', ')})` : ''}`,
            );
          }
        };
        if (kind === 'all' || kind === 'paragraph') add('paragraph styles', 'ParagraphStyle');
        if (kind === 'all' || kind === 'character') add('character styles', 'CharacterStyle');
        if (kind === 'all' || kind === 'object') add('object styles', 'ObjectStyle');
        return ok(lines.join('\n'), out);
      }),
  );

  server.registerTool(
    'create_paragraph_style',
    {
      title: 'Create paragraph style',
      description:
        'Creates a paragraph style (font, size, leading, alignment, spacing, color…). Apply it with add_text_frame, set_text or apply_paragraph_style.',
      inputSchema: z.object({
        document: documentParam,
        name: z.string(),
        basedOn: z.string().optional(),
        nextStyle: z.string().optional(),
        group: z.string().optional().describe('Style group (folder) name.'),
        ...textStyleFields,
        ...paragraphFields,
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { document: _d, ...spec } = args;
        const info = createParagraphStyle(doc, spec);
        ctx.save(doc);
        return ok(`Created paragraph style "${info.name}".`, { style: info });
      }),
  );

  server.registerTool(
    'create_character_style',
    {
      title: 'Create character style',
      description:
        'Creates a character style for inline formatting (e.g. "Emphasis": italic; "Price": bold red). Apply it with format_text.',
      inputSchema: z.object({
        document: documentParam,
        name: z.string(),
        basedOn: z.string().optional(),
        group: z.string().optional(),
        ...textStyleFields,
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { document: _d, ...spec } = args;
        const info = createCharacterStyle(doc, spec);
        ctx.save(doc);
        return ok(`Created character style "${info.name}".`, { style: info });
      }),
  );

  server.registerTool(
    'update_style',
    {
      title: 'Update style',
      description:
        'Changes settings of an existing paragraph or character style. Everything using the style updates automatically in InDesign.',
      inputSchema: z.object({
        document: documentParam,
        kind: z.enum(['paragraph', 'character']),
        style: z.string(),
        basedOn: z.string().optional(),
        nextStyle: z.string().optional(),
        ...textStyleFields,
        ...paragraphFields,
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const el = resolveStyle(
          doc,
          args.kind === 'paragraph' ? 'ParagraphStyle' : 'CharacterStyle',
          args.style,
        );
        const { document: _d, kind: _k, style: _s, ...spec } = args;
        applyStyleSpec(doc, el, spec);
        ctx.save(doc);
        return ok(`Updated ${args.kind} style "${args.style}".`);
      }),
  );

  server.registerTool(
    'delete_style',
    {
      title: 'Delete style',
      description:
        'Deletes a paragraph or character style; text using it gets the replacement style (default: basic/none).',
      inputSchema: z.object({
        document: documentParam,
        kind: z.enum(['paragraph', 'character']),
        style: z.string(),
        replaceWith: z.string().optional(),
      }),
      annotations: { destructiveHint: true },
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        deleteStyle(
          doc,
          args.kind === 'paragraph' ? 'ParagraphStyle' : 'CharacterStyle',
          args.style,
          args.replaceWith,
        );
        ctx.save(doc);
        return ok(`Deleted ${args.kind} style "${args.style}".`);
      }),
  );

  server.registerTool(
    'list_swatches',
    {
      title: 'List swatches',
      description: 'Lists color swatches with their values and an approximate hex color.',
      inputSchema: z.object({ document: documentParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(() => {
        const swatches = listSwatches(ctx.open(document));
        return ok(
          swatches
            .map(
              (s) =>
                `${s.name}${s.space ? ` (${s.space} ${s.values.join(' ')})` : ''}${s.hex ? ` ${s.hex}` : ''}${s.model === 'Spot' ? ' spot' : ''}`,
            )
            .join('\n'),
          { swatches },
        );
      }),
  );

  server.registerTool(
    'create_swatch',
    {
      title: 'Create swatch',
      description: 'Creates a named color swatch from CMYK, RGB or hex values (CMYK recommended for print).',
      inputSchema: z.object({
        document: documentParam,
        name: z.string().optional().describe('Swatch name (default: InDesign-style "C=0 M=100 Y=0 K=0").'),
        color: z.string().optional().describe('"#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)".'),
        cmyk: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .optional()
          .describe('Percentages 0-100.'),
        rgb: z.tuple([z.number(), z.number(), z.number()]).optional(),
        spot: z.boolean().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const parsed = args.color ? parseColorString(args.color) : undefined;
        if (args.color && !parsed) throw new Error(`Cannot understand color "${args.color}"`);
        const info = createSwatch(doc, {
          name: args.name,
          cmyk: args.cmyk ?? parsed?.cmyk,
          rgb: args.rgb ?? parsed?.rgb,
          hex: parsed?.hex,
          spot: args.spot,
        });
        ctx.save(doc);
        return ok(`Created swatch "${info.name}"${info.hex ? ` (${info.hex})` : ''}.`, { swatch: info });
      }),
  );

  server.registerTool(
    'list_fonts',
    {
      title: 'List fonts',
      description:
        'Lists the fonts the document refers to. Fonts must be installed on the computer that opens the document in InDesign.',
      inputSchema: z.object({ document: documentParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(() => {
        const fonts = listFonts(ctx.open(document));
        return ok(
          fonts
            .map(
              (f) =>
                `${f.family}: ${f.styles.join(', ')}${f.status && f.status !== 'Installed' ? ` (${f.status})` : ''}`,
            )
            .join('\n') || 'No fonts listed',
          { fonts },
        );
      }),
  );
}
