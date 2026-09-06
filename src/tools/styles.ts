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
import type { ToolRegistry } from './registry.ts';
import { colorParam, documentParam, itemParam, ok, pageParam, run, toolInput } from './shared.ts';

const textStyleFields = {
  font: z
    .string()
    .optional()
    .describe('Font family, e.g. "Helvetica Neue". Must be installed on the designer\'s computer.'),
  fontStyle: z.string().optional().describe('Font style name: Regular, Bold, Italic, Light, Semibold…'),
  size: z.number().min(0.1).max(1296).optional().describe('Point size (0.1–1296, as in InDesign).'),
  leading: z
    .union([z.number().min(0).max(5000), z.literal('auto')])
    .optional()
    .describe('Line spacing in points, or "auto".'),
  color: colorParam.optional(),
  tracking: z
    .number()
    .min(-1000)
    .max(10000)
    .optional()
    .describe('Letter spacing in 1/1000 em (-1000 to 10000).'),
  capitalization: z.enum(['normal', 'small-caps', 'all-caps', 'cap-to-small-cap']).optional(),
  underline: z.boolean().optional(),
  strikeThrough: z.boolean().optional(),
  position: z.enum(['normal', 'superscript', 'subscript']).optional(),
  horizontalScale: z.number().min(1).max(1000).optional().describe('Percent (1–1000).'),
  baselineShift: z.number().min(-5000).max(5000).optional().describe('Points.'),
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
  spaceBefore: z.number().min(0).max(8640).optional().describe('Points.'),
  spaceAfter: z.number().min(0).max(8640).optional(),
  leftIndent: z.number().min(0).max(8640).optional(),
  rightIndent: z.number().min(0).max(8640).optional(),
  firstLineIndent: z.number().min(-8640).max(8640).optional(),
  hyphenate: z.boolean().optional(),
  keepLinesTogether: z.boolean().optional(),
  dropCapLines: z.number().int().min(0).max(25).optional(),
  dropCapCharacters: z.number().int().min(0).max(150).optional(),
};

export function registerStyleTools(reg: ToolRegistry, ctx: ToolContext): void {
  reg.tool(
    'list_styles',
    {
      title: 'List styles',
      description: 'Lists paragraph, character and object styles with their main settings.',
      inputSchema: toolInput({
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

  reg.tool(
    'create_paragraph_style',
    {
      title: 'Create paragraph style',
      description:
        'Creates a paragraph style (font, size, leading, alignment, spacing, color…). Apply it with add_text_frame, set_text or apply_paragraph_style.',
      inputSchema: toolInput({
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

  reg.tool(
    'create_character_style',
    {
      title: 'Create character style',
      description:
        'Creates a character style for inline formatting (e.g. "Emphasis": italic; "Price": bold red). Apply it with format_text.',
      inputSchema: toolInput({
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

  reg.tool(
    'update_style',
    {
      title: 'Update style',
      description:
        'Changes settings of an existing paragraph or character style. Everything using the style updates automatically in InDesign.',
      inputSchema: toolInput({
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

  reg.tool(
    'delete_style',
    {
      title: 'Delete style',
      description:
        'Deletes a paragraph or character style; text using it gets the replacement style (default: basic/none).',
      inputSchema: toolInput({
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

  reg.tool(
    'list_swatches',
    {
      title: 'List swatches',
      description: 'Lists color swatches with their values and an approximate hex color.',
      inputSchema: toolInput({ document: documentParam }),
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

  reg.tool(
    'create_swatch',
    {
      title: 'Create swatch',
      description: 'Creates a named color swatch from CMYK, RGB or hex values (CMYK recommended for print).',
      inputSchema: toolInput({
        document: documentParam,
        name: z.string().optional().describe('Swatch name (default: InDesign-style "C=0 M=100 Y=0 K=0").'),
        color: z.string().optional().describe('"#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)".'),
        cmyk: z
          .tuple([
            z.number().min(0).max(100),
            z.number().min(0).max(100),
            z.number().min(0).max(100),
            z.number().min(0).max(100),
          ])
          .optional()
          .describe('Percentages 0-100.'),
        rgb: z
          .tuple([
            z.number().int().min(0).max(255),
            z.number().int().min(0).max(255),
            z.number().int().min(0).max(255),
          ])
          .optional()
          .describe('Values 0-255.'),
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

  reg.tool(
    'list_fonts',
    {
      title: 'List fonts',
      description:
        'Lists the fonts the document refers to. Fonts must be installed on the computer that opens the document in InDesign.',
      inputSchema: toolInput({ document: documentParam }),
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

/** Object styles and gradient swatches. */
export function registerObjectStyleTools(reg: ToolRegistry, ctx: ToolContext): void {
  reg.tool(
    'create_object_style',
    {
      title: 'Create object style',
      description:
        'Creates an object style: fill, stroke, corners, opacity, text frame options and a paragraph style in one reusable set. Apply it with apply_object_style.',
      inputSchema: toolInput({
        document: documentParam,
        name: z.string(),
        basedOn: z.string().optional(),
        fill: colorParam.optional(),
        fillTint: z.number().min(0).max(100).optional(),
        stroke: colorParam.optional(),
        strokeWeight: z.number().min(0).optional(),
        strokeType: z.string().optional().describe('Solid, Dashed, Dotted…'),
        strokeAlignment: z.enum(['center', 'inside', 'outside']).optional(),
        cornerRadius: z.number().min(0).optional().describe('Points.'),
        cornerShape: z.enum(['rounded', 'inverse-rounded', 'bevel', 'inset', 'fancy', 'none']).optional(),
        opacity: z.number().min(0).max(100).optional(),
        paragraphStyle: z
          .string()
          .optional()
          .describe('Paragraph style applied to text in frames using this style.'),
        columns: z.number().int().min(1).max(20).optional(),
        gutter: z.number().min(0).optional(),
        inset: z.number().min(0).optional(),
        verticalJustification: z.enum(['top', 'center', 'bottom', 'justify']).optional(),
        textWrap: z.enum(['none', 'bounding-box']).optional(),
        textWrapOffset: z.number().min(0).optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { document: _d, ...spec } = args;
        const { createObjectStyle } = require('../idml/styles.ts') as typeof import('../idml/styles.ts');
        const info = createObjectStyle(doc, spec);
        ctx.save(doc);
        return ok(`Created object style "${info.name}".`, { style: info });
      }),
  );

  reg.tool(
    'update_object_style',
    {
      title: 'Update object style',
      description: 'Changes an existing object style. Items using it follow automatically in InDesign.',
      inputSchema: toolInput({
        document: documentParam,
        style: z.string(),
        fill: colorParam.optional(),
        stroke: colorParam.optional(),
        strokeWeight: z.number().min(0).optional(),
        cornerRadius: z.number().min(0).optional(),
        cornerShape: z.enum(['rounded', 'inverse-rounded', 'bevel', 'inset', 'fancy', 'none']).optional(),
        opacity: z.number().min(0).max(100).optional(),
        paragraphStyle: z.string().optional(),
        columns: z.number().int().min(1).max(20).optional(),
        inset: z.number().min(0).optional(),
        verticalJustification: z.enum(['top', 'center', 'bottom', 'justify']).optional(),
        textWrap: z.enum(['none', 'bounding-box']).optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { document: _d, style, ...spec } = args;
        const { updateObjectStyle } = require('../idml/styles.ts') as typeof import('../idml/styles.ts');
        const info = updateObjectStyle(doc, style, spec);
        ctx.save(doc);
        return ok(`Updated object style "${info.name}".`, { style: info });
      }),
  );

  reg.tool(
    'create_gradient',
    {
      title: 'Create gradient swatch',
      description:
        'Creates a linear or radial gradient swatch from two or more colours. Use it as a fill like any swatch.',
      inputSchema: toolInput({
        document: documentParam,
        name: z.string(),
        type: z.enum(['linear', 'radial']).default('linear'),
        stops: z
          .array(
            z.object({
              color: colorParam,
              location: z.number().min(0).max(100).optional(),
              midpoint: z.number().min(0).max(100).optional(),
            }),
          )
          .min(2)
          .describe('Colours from start to end; locations default to an even spread.'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { createGradient } = require('../idml/styles.ts') as typeof import('../idml/styles.ts');
        const info = createGradient(doc, { name: args.name, type: args.type, stops: args.stops });
        ctx.save(doc);
        return ok(
          `Created ${args.type} gradient "${info.name}". Use it as a fill, e.g. set_appearance with fill "${info.name}".`,
          { swatch: info },
        );
      }),
  );

  reg.tool(
    'set_gradient_geometry',
    {
      title: 'Gradient direction',
      description:
        'Sets the angle and length of a gradient fill on an item (0° = left to right, 90° = bottom to top).',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        angle: z.number().optional(),
        length: z.number().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { findItem } = require('../idml/items.ts') as typeof import('../idml/items.ts');
        const { setGradientFillGeometry } =
          require('../idml/styles.ts') as typeof import('../idml/styles.ts');
        const found = findItem(doc, args.item, args.page);
        setGradientFillGeometry(found.element, { angle: args.angle, length: args.length });
        ctx.save(doc);
        return ok('Gradient direction updated.');
      }),
  );
}
