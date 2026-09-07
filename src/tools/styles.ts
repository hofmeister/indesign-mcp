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
import {
  colorParam,
  createAll,
  createdSummary,
  documentParam,
  itemParam,
  makeOptional,
  ok,
  oneOrMany,
  pageParam,
  requireNames,
  run,
  toolInput,
} from './shared.ts';

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

/**
 * Orders a set of styles so a parent is created before the styles based on it, and returns the
 * `nextStyle` links to apply afterwards. A style may point `nextStyle` at itself or at one defined
 * later in the same call — both are ordinary in a style sheet, and neither exists yet while the
 * styles are being created.
 */
function orderStyleSpecs<T extends { name: string; basedOn?: string; nextStyle?: string }>(
  specs: T[],
): { ordered: Omit<T, 'nextStyle'>[]; links: { name: string; nextStyle: string }[] } {
  const byName = new Map(specs.map((s) => [s.name.toLowerCase(), s]));
  const ordered: T[] = [];
  const done = new Set<string>();
  const visit = (spec: T, seen: Set<string>) => {
    const key = spec.name.toLowerCase();
    if (done.has(key) || seen.has(key)) return;
    seen.add(key);
    const parent = spec.basedOn ? byName.get(spec.basedOn.toLowerCase()) : undefined;
    if (parent && parent !== spec) visit(parent, seen);
    done.add(key);
    ordered.push(spec);
  };
  for (const spec of specs) visit(spec, new Set());
  const links: { name: string; nextStyle: string }[] = [];
  const stripped = ordered.map(({ nextStyle, ...rest }) => {
    if (nextStyle) links.push({ name: rest.name, nextStyle });
    return rest as Omit<T, 'nextStyle'>;
  });
  return { ordered: stripped, links };
}

export function registerStyleTools(reg: ToolRegistry, ctx: ToolContext): void {
  reg.listing(
    'styles',
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

  const paragraphStyleFields = {
    name: z.string(),
    basedOn: z.string().optional(),
    nextStyle: z.string().optional(),
    group: z.string().optional().describe('Style group (folder) name.'),
    ...textStyleFields,
    ...paragraphFields,
  };

  reg.tool(
    'create_paragraph_style',
    {
      title: 'Create paragraph styles',
      description:
        'Creates one paragraph style (font, size, leading, alignment, spacing, color…) or a whole set in one call — pass "styles" with the list. Define the document\'s styles in a single call rather than one call each. Apply them with add_text_frame, set_text or apply_paragraph_style.',
      inputSchema: toolInput({
        document: documentParam,
        ...makeOptional(paragraphStyleFields),
        styles: z
          .array(toolInput(paragraphStyleFields))
          .optional()
          .describe(
            'Several styles at once, e.g. [{name:"Headline",font:"Helvetica",size:28,...},{name:"Body",size:10,...}]. Use this instead of the single-style fields.',
          ),
      }),
    },
    async (args) =>
      run(() => {
        const { document, styles, ...single } = args;
        const specs = requireNames(
          oneOrMany(single, styles, { one: 'paragraph style', list: 'styles' }),
          'paragraph style',
        );
        const { ordered, links } = orderStyleSpecs(
          specs as { name: string; basedOn?: string; nextStyle?: string }[],
        );
        const { doc, results } = createAll(ctx, document, ordered, (d, spec) =>
          createParagraphStyle(d, spec as Parameters<typeof createParagraphStyle>[1]),
        );
        // The nextStyle links go on once every style in the call exists.
        if (links.length) {
          for (const link of links)
            applyStyleSpec(doc, resolveStyle(doc, 'ParagraphStyle', link.name), {
              nextStyle: link.nextStyle,
            } as never);
          ctx.save(doc);
        }
        return ok(
          createdSummary(
            'paragraph style',
            'paragraph styles',
            results.map((r) => r.name),
          ),
          { styles: results },
        );
      }),
  );

  const characterStyleFields = {
    name: z.string(),
    basedOn: z.string().optional(),
    group: z.string().optional(),
    ...textStyleFields,
  };

  reg.tool(
    'create_character_style',
    {
      title: 'Create character styles',
      description:
        'Creates one character style for inline formatting (e.g. "Emphasis": italic; "Price": bold red) or several at once — pass "styles" with the list. Apply them with format_text.',
      inputSchema: toolInput({
        document: documentParam,
        ...makeOptional(characterStyleFields),
        styles: z
          .array(toolInput(characterStyleFields))
          .optional()
          .describe('Several styles at once. Use this instead of the single-style fields.'),
      }),
    },
    async (args) =>
      run(() => {
        const { document, styles, ...single } = args;
        const specs = requireNames(
          oneOrMany(single, styles, { one: 'character style', list: 'styles' }),
          'character style',
        );
        const { ordered } = orderStyleSpecs(specs as { name: string; basedOn?: string }[]);
        const { results } = createAll(ctx, document, ordered, (doc, spec) =>
          createCharacterStyle(doc, spec as Parameters<typeof createCharacterStyle>[1]),
        );
        return ok(
          createdSummary(
            'character style',
            'character styles',
            results.map((r) => r.name),
          ),
          { styles: results },
        );
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

  reg.listing(
    'swatches',
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

  const swatchFields = {
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
  };

  reg.tool(
    'create_swatch',
    {
      title: 'Create swatches',
      description:
        'Creates one named colour swatch from CMYK, RGB or hex values, or a whole palette in one call — pass "swatches" with the list (CMYK recommended for print). Define the document\'s palette in a single call rather than one call each.',
      inputSchema: toolInput({
        document: documentParam,
        ...swatchFields,
        swatches: z
          .array(toolInput(swatchFields))
          .optional()
          .describe(
            'A whole palette at once, e.g. [{name:"Brand Blue",color:"cmyk(90,60,0,0)"},{name:"Sand",color:"#e8dcc8"}]. Use this instead of the single-swatch fields.',
          ),
      }),
    },
    async (args) =>
      run(() => {
        const { document, swatches, ...single } = args;
        const specs = oneOrMany(single, swatches, { one: 'swatch', list: 'swatches' });
        const { results } = createAll(ctx, document, specs, (doc, spec) => {
          const parsed = spec.color ? parseColorString(spec.color) : undefined;
          if (spec.color && !parsed) throw new Error(`Cannot understand color "${spec.color}"`);
          return createSwatch(doc, {
            name: spec.name,
            cmyk: spec.cmyk ?? parsed?.cmyk,
            rgb: spec.rgb ?? parsed?.rgb,
            hex: parsed?.hex,
            spot: spec.spot,
          });
        });
        const text =
          results.length === 1
            ? `Created swatch "${results[0]!.name}"${results[0]!.hex ? ` (${results[0]!.hex})` : ''}.`
            : `Created ${results.length} swatches: ${results.map((r) => `${r.name}${r.hex ? ` (${r.hex})` : ''}`).join(', ')}.`;
        return ok(text, { swatches: results });
      }),
  );

  reg.listing(
    'fonts',
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
  const objectStyleFields = {
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
  };

  reg.tool(
    'create_object_style',
    {
      title: 'Create object styles',
      description:
        'Creates one object style — fill, stroke, corners, opacity, text frame options and a paragraph style in one reusable set — or several at once by passing "styles" with the list. Apply them with apply_object_style.',
      inputSchema: toolInput({
        document: documentParam,
        ...makeOptional(objectStyleFields),
        styles: z
          .array(toolInput(objectStyleFields))
          .optional()
          .describe('Several object styles at once. Use this instead of the single-style fields.'),
      }),
    },
    async (args) =>
      run(() => {
        const { document, styles, ...single } = args;
        const specs = requireNames(
          oneOrMany(single, styles, { one: 'object style', list: 'styles' }),
          'object style',
        );
        const { createObjectStyle } = require('../idml/styles.ts') as typeof import('../idml/styles.ts');
        const { results } = createAll(ctx, document, specs, (doc, spec) =>
          createObjectStyle(doc, spec as Parameters<typeof createObjectStyle>[1]),
        );
        return ok(
          createdSummary(
            'object style',
            'object styles',
            results.map((r) => r.name),
          ),
          { styles: results },
        );
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
