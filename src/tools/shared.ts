import * as z from 'zod';
import type { IdmlDocument } from '../idml/document.ts';
import type { Rect } from '../idml/geometry.ts';
import { formatLength } from '../idml/units.ts';
import type { ToolContext } from './context.ts';

export const documentParam = z
  .string()
  .describe(
    'Path to the .idml file. A bare file name is looked up in the documents folder. Use ~ for your home folder.',
  );

export const lengthParam = z
  .union([z.number(), z.string()])
  .describe(
    'A length: a number in the default unit (mm) or a string with a unit such as "10mm", "0.5in", "12pt".',
  );

export const pageParam = z
  .union([z.number().int().positive(), z.string()])
  .describe('Page number (1 = first page) or the page name shown in InDesign.');

export const itemParam = z.string().describe("The item's name or id (see describe_document / list items).");

export const masterPageParam = z
  .union([z.number().int().min(1), z.enum(['left', 'right'])])
  .optional()
  .describe(
    'Which page of the master to put it on: "left" (default), "right", or a 1-based number for a master with more pages. A facing-pages master has two pages, and an item on one of them only appears on the document pages of that side, so a running head belongs on both.',
  );

export const colorParam = z
  .string()
  .describe(
    'A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values. Hex and rgb make RGB swatches, which preflight flags for print: for print work write the colour as "cmyk(75,45,0,60) as Brand Deep".',
  );

export const paragraphInput = z.object({
  text: z.string().describe('Paragraph text; **bold** and *italic* supported.'),
  style: z.string().optional().describe('Paragraph style name.'),
});

/**
 * Wraps a field so a value the client sent as a JSON string is still understood: a number as "41",
 * or an array/object as its JSON text.
 *
 * The value is only reinterpreted when the string itself is rejected and the decoded value is
 * accepted, so genuine string fields (a style named "41", a page name) are never touched and
 * out-of-range values still fail. The advertised JSON Schema is unchanged.
 *
 * When the string was clearly meant to be JSON but does not parse, the parser's own complaint is
 * reported instead of the type mismatch it causes. "expected array, received string" sends you
 * looking at the array; the truth is usually a bad escape in a string several levels down.
 */
function tolerantInput(inner: z.ZodType): z.ZodType {
  const wrapped = z.preprocess((v, ctx) => {
    if (typeof v !== 'string' || inner.safeParse(v).success) return v;
    const t = v.trim();
    if (t !== '' && Number.isFinite(Number(t)) && inner.safeParse(Number(t)).success) return Number(t);
    if (!/^[[{]/.test(t)) return v;
    try {
      const decoded: unknown = JSON.parse(t);
      if (inner.safeParse(decoded).success) return decoded;
      return decoded;
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        message: `was sent as JSON text that does not parse: ${(e as Error).message}. Send it as a real array or object, or check for a bad escape inside one of its strings.`,
      });
      return v;
    }
  }, inner);
  // Carry the description onto the wrapper. Generated JSON Schema finds it on the inner schema
  // either way, but code that merges shapes (the family tools) reads it from the field itself.
  return inner.description ? wrapped.describe(inner.description) : wrapped;
}

/**
 * Where a setting actually lives, when it was sent to a tool that does not take it. Refusing an
 * option is right; refusing it without saying where it belongs costs a round trip.
 */
const KEY_HINTS: { keys: string[]; hint: string }[] = [
  {
    keys: [
      'alignment',
      'font',
      'fontStyle',
      'size',
      'leading',
      'color',
      'tracking',
      'capitalization',
      'underline',
      'strikeThrough',
      'spaceBefore',
      'spaceAfter',
      'leftIndent',
      'rightIndent',
      'firstLineIndent',
      'hyphenation',
      'keepLines',
      'dropCapLines',
      'dropCapCharacters',
    ],
    hint: 'Formatting is not set where a style is applied: change the style itself with update_style (every frame using it follows), or format this text directly with format_text.',
  },
  {
    keys: ['x', 'y', 'width', 'height', 'rotation'],
    hint: 'Move, resize or rotate an existing item with edit_item (op "move", "resize" or "rotate").',
  },
  { keys: ['layer'], hint: 'Move an existing item to another layer with edit_item (op "layer").' },
  {
    keys: ['fill', 'stroke', 'strokeWeight', 'opacity'],
    hint: 'Change the look of an existing item with set_appearance.',
  },
];

/** Cheap edit distance, capped: only used to suggest a near miss like "aligment" -> "alignment". */
function closeTo(bad: string, valid: string[]): string | undefined {
  const b = bad.toLowerCase();
  let best: string | undefined;
  let bestScore = 3;
  for (const v of valid) {
    const a = v.toLowerCase();
    if (a === b) return v;
    let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let i = 1; i <= b.length; i++) {
      const row = [i];
      for (let j = 1; j <= a.length; j++)
        row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (b[i - 1] === a[j - 1] ? 0 : 1));
      prev = row;
    }
    const score = prev[a.length]!;
    if (score < bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

function unknownKeyMessage(bad: readonly string[], valid: string[]): string {
  const lines = [
    `${bad.length === 1 ? `Unknown option "${bad[0]}"` : `Unknown options ${bad.map((k) => `"${k}"`).join(', ')}`}. This tool takes: ${valid.join(', ')}.`,
  ];
  for (const key of bad) {
    const near = closeTo(key, valid);
    if (near) lines.push(`Did you mean "${near}"?`);
    const hint = KEY_HINTS.find((h) => h.keys.includes(key))?.hint;
    if (hint && !valid.includes(key)) lines.push(hint);
  }
  return [...new Set(lines)].join(' ');
}

/**
 * Builds a tool input schema. Same as `z.strictObject`, but tolerant of values a client stringified,
 * and explicit about an option it does not know.
 */
export function toolInput<T extends z.ZodRawShape>(shape: T): z.ZodObject<T, z.core.$strict> {
  const wrapped: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(shape)) wrapped[key] = tolerantInput(schema as z.ZodType);
  const valid = Object.keys(shape);
  return z.strictObject(wrapped as unknown as T, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? unknownKeyMessage((issue as { keys: readonly string[] }).keys, valid)
        : undefined,
  });
}

/**
 * The same shape with every field optional — the single-item half of a tool that also takes a list,
 * where the required fields move into the list's own items.
 */
export function makeOptional<T extends z.ZodRawShape>(shape: T): { [K in keyof T]: z.ZodOptional<T[K]> } {
  const out: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(shape)) out[key] = (schema as z.ZodType).optional();
  return out as { [K in keyof T]: z.ZodOptional<T[K]> };
}

/** Every spec must carry a name, whichever half of the tool it arrived through. */
export function requireNames<T extends { name?: string }>(
  specs: T[],
  label: string,
): (T & { name: string })[] {
  for (const spec of specs) if (!spec.name?.trim()) throw new Error(`Every ${label} needs a name.`);
  return specs as (T & { name: string })[];
}

/**
 * Lets a create_* tool take one item or a whole list of them.
 *
 * Setting a document up means a dozen swatches and paragraph styles, and spending one tool call on
 * each is what makes a long build run out of turns before the layout is finished. `single` is the
 * tool's own arguments minus `document` and the list; it counts as given when any field is set.
 */
export function oneOrMany<T extends object>(
  single: T,
  many: T[] | undefined,
  labels: { one: string; list: string },
): T[] {
  const singleGiven = Object.values(single).some((v) => v !== undefined);
  if (many !== undefined) {
    if (singleGiven)
      throw new Error(
        `Give either one ${labels.one} or a "${labels.list}" list, not both — put every one of them in the list.`,
      );
    if (!many.length) throw new Error(`"${labels.list}" is empty; give at least one ${labels.one}.`);
    return many;
  }
  if (!singleGiven)
    throw new Error(`Give a ${labels.one} to create, or a "${labels.list}" list to create several.`);
  return [single];
}

/**
 * Creates every spec against the same open document and saves once. Nothing is written when one of
 * them fails, and the half-built document is dropped from the cache so the next call re-reads it.
 */
export function createAll<T, R>(
  ctx: ToolContext,
  document: string,
  specs: T[],
  create: (doc: IdmlDocument, spec: T) => R,
): { doc: IdmlDocument; results: R[] } {
  const doc = ctx.open(document);
  const results: R[] = [];
  for (const [i, spec] of specs.entries()) {
    try {
      results.push(create(doc, spec));
    } catch (err) {
      ctx.forget(doc.path ?? document);
      if (specs.length === 1) throw new Error((err as Error).message);
      const where = ` (number ${i + 1} of ${specs.length})`;
      // Dropping the document from the cache undoes the half-built set — unless a batch is holding
      // the writes, where the earlier steps' edits are in the same document and have to be kept.
      const kept = ctx.savesDeferred
        ? i === 0
          ? ' Nothing was created.'
          : ` The first ${i} were created and are kept.`
        : ' Nothing was created.';
      throw new Error(`${(err as Error).message}${where}.${kept}`);
    }
  }
  ctx.save(doc);
  return { doc, results };
}

/** "Created 3 swatches: Brand Blue, Sand, Ink." / "Created swatch "Brand Blue"." */
export function createdSummary(one: string, plural: string, names: string[]): string {
  return names.length === 1
    ? `Created ${one} "${names[0]}".`
    : `Created ${names.length} ${plural}: ${names.join(', ')}.`;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

export function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Runs a tool body, converting exceptions into MCP error results. */
export async function run(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}

/** Opens, mutates, saves. Returns the path. */
export function withDocument(ctx: ToolContext, path: string, mutate: (doc: IdmlDocument) => void): string {
  const doc = ctx.open(path);
  mutate(doc);
  return ctx.save(doc);
}

export function rectText(ctx: ToolContext, r: Rect | undefined): string {
  if (!r) return 'unknown position';
  const u = ctx.unit;
  return `at ${formatLength(r.x, u)}, ${formatLength(r.y, u)} size ${formatLength(r.width, u)} × ${formatLength(r.height, u)}`;
}

export function rectStructured(
  r: Rect | undefined,
  unit: 'mm' | 'cm' | 'in' | 'pt' | 'px' | 'p',
): Record<string, string> | undefined {
  if (!r) return undefined;
  return {
    x: formatLength(r.x, unit),
    y: formatLength(r.y, unit),
    width: formatLength(r.width, unit),
    height: formatLength(r.height, unit),
  };
}
