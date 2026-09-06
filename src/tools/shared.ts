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

export const colorParam = z
  .string()
  .describe(
    'A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches; add "as <name>" ("#14342b as Brand Green") to name the swatch instead of letting it be called after its values.',
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
 * Builds a tool input schema. Same as `z.strictObject`, but tolerant of values a client stringified.
 */
export function toolInput<T extends z.ZodRawShape>(shape: T): z.ZodObject<T, z.core.$strict> {
  const wrapped: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(shape)) wrapped[key] = tolerantInput(schema as z.ZodType);
  return z.strictObject(wrapped as unknown as T);
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
