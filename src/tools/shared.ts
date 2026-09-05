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

export const itemParam = z.string().describe("The item's name or id (see describe_document / list_items).");

export const colorParam = z
  .string()
  .describe(
    'A swatch name ("Black", "Paper", "Brand Blue"), "none", a hex color like "#ff6600", "cmyk(0,60,100,0)" or "rgb(255,102,0)". Unknown colors are created as new swatches.',
  );

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
