// Guardrails on tool input: sizes that cannot work are refused with an explanation, and items
// that land off the page come back with a warning instead of silently disappearing.
import type { IdmlDocument } from '../idml/document.ts';
import type { Rect } from '../idml/geometry.ts';
import { masterPageIndex } from '../idml/items.ts';
import { documentPageSize, findPage } from '../idml/pages.ts';
import { formatLength } from '../idml/units.ts';
import { attr, children } from '../idml/xml.ts';
import type { ToolContext } from './context.ts';

/** InDesign's largest page or object dimension: 5486 mm. */
export const MAX_DIMENSION_PT = 15552;

export interface PlacementTarget {
  page?: number | string;
  master?: string;
}

export interface PageBox {
  name: string;
  width: number;
  height: number;
}

function len(ctx: ToolContext, value: number): string {
  return formatLength(value, ctx.unit);
}

/** The page (or master page) an item is being placed on, for the fit checks. */
export function pageBoxFor(doc: IdmlDocument, target: PlacementTarget): PageBox | undefined {
  try {
    if (target.master) {
      const size = documentPageSize(doc);
      return { name: `master ${target.master}`, width: size.width, height: size.height };
    }
    const page = findPage(doc, target.page ?? 1);
    return { name: `page ${page.index}`, width: page.width, height: page.height };
  } catch {
    return undefined; // the tool itself reports an unknown page
  }
}

/**
 * A note for an item put on one page of a multi-page master.
 *
 * A facing-pages master has a left and a right page (a gatefold has more), and an item goes on
 * one of them: InDesign only shows it on the document pages of that side. A running head placed
 * once is then missing from every second page, which is easy to miss until the whole thing prints.
 */
export function masterSideNotes(
  doc: IdmlDocument,
  target: { master?: string; masterPage?: number | 'left' | 'right' },
  what: string,
  rect?: Rect,
): string[] {
  if (!target.master) return [];
  const spread = doc.masterSpreads().find((m) => {
    const name = attr(m, 'Name') ?? `${attr(m, 'NamePrefix') ?? ''}-${attr(m, 'BaseName') ?? ''}`;
    return name.toLowerCase() === target.master!.toLowerCase() || attr(m, 'Self') === target.master;
  });
  if (!spread) return [];
  const count = children(spread, 'Page').length;
  if (count < 2) return [];
  const index = masterPageIndex(target.masterPage, count);
  const notes: string[] = [];
  // An item reaching over the spine belongs to the spread as far as InDesign is concerned: it is
  // painted across the neighbouring page too, even where that page uses a different master.
  if (rect) {
    const size = documentPageSize(doc);
    const overSpine = index === 0 ? rect.x + rect.width > size.width + 0.5 : rect.x < -0.5;
    if (overSpine)
      notes.push(
        `the ${what} reaches over the spine of ${target.master}, and InDesign paints such an item across the whole spread — including a facing page that uses another master. Keep it inside its own page (bleed on the outer edge only) unless that is what you want.`,
      );
  }
  if (count === 2) {
    const side = index === 0 ? 'left' : 'right';
    const other = index === 0 ? 'right' : 'left';
    notes.push(
      `${target.master} has two pages and the ${what} went on the ${side} one, so it will only show on ${side}-hand pages. Add another with masterPage: "${other}" if it should repeat on every page.`,
    );
    return notes;
  }
  const others = Array.from({ length: count }, (_, i) => i + 1).filter((n) => n !== index + 1);
  notes.push(
    `${target.master} has ${count} pages and the ${what} went on page ${index + 1} of it, so it will only show on the document pages using that page. Add another with masterPage: ${others.join(' or ')} if it should repeat.`,
  );
  return notes;
}

/**
 * Refuses sizes that cannot draw anything: a frame needs a positive width and height, and nothing
 * may be larger than InDesign allows.
 */
export function requireSize(ctx: ToolContext, rect: Rect, what: string): void {
  for (const [name, value] of [
    ['x', rect.x],
    ['y', rect.y],
    ['width', rect.width],
    ['height', rect.height],
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`The ${name} of the ${what} is not a number.`);
  }
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error(
      `A ${what} needs a positive width and height, but I was given ${len(ctx, rect.width)} × ${len(ctx, rect.height)}. ` +
        'Width and height are sizes, not coordinates — use x and y to say where it goes.',
    );
  }
  if (rect.width > MAX_DIMENSION_PT || rect.height > MAX_DIMENSION_PT) {
    throw new Error(
      `${len(ctx, Math.max(rect.width, rect.height))} is bigger than InDesign allows (at most ${len(ctx, MAX_DIMENSION_PT)}).`,
    );
  }
}

/** Refuses a line that would be a single point. */
export function requireLine(
  ctx: ToolContext,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  for (const [name, value] of [
    ['x1', from.x],
    ['y1', from.y],
    ['x2', to.x],
    ['y2', to.y],
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`${name} is not a number.`);
  }
  if (Math.abs(from.x - to.x) < 0.01 && Math.abs(from.y - to.y) < 0.01) {
    throw new Error(
      `A line needs two different points, but both ends are at ${len(ctx, from.x)}, ${len(ctx, from.y)}.`,
    );
  }
}

/**
 * Warnings about where an item lands: entirely on the pasteboard, or hanging over the trim edge.
 * These are notes, not errors — both are legitimate in a real layout.
 */
export function placementWarnings(
  ctx: ToolContext,
  rect: Rect,
  box: PageBox | undefined,
  what: string,
): string[] {
  if (!box) return [];
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const outside = right <= 0 || bottom <= 0 || rect.x >= box.width || rect.y >= box.height;
  const pageSize = `${box.name} is ${len(ctx, box.width)} × ${len(ctx, box.height)}`;
  if (outside) {
    return [
      `${what} sits entirely off ${box.name}, on the pasteboard, so it will not print (${pageSize}). ` +
        `Positions are measured from the top-left corner of the page.`,
    ];
  }
  const over: string[] = [];
  if (rect.x < 0) over.push(`${len(ctx, -rect.x)} past the left edge`);
  if (rect.y < 0) over.push(`${len(ctx, -rect.y)} past the top edge`);
  if (right > box.width) over.push(`${len(ctx, right - box.width)} past the right edge`);
  if (bottom > box.height) over.push(`${len(ctx, bottom - box.height)} past the bottom edge`);
  if (!over.length) return [];
  return [
    `${what} runs ${over.join(' and ')} of ${box.name} (${pageSize}); InDesign will cut it off at the trim. ` +
      'That is what you want for a bleed element, otherwise move or resize it.',
  ];
}

/** Checks a new item's rectangle and returns any notes for the tool's answer. */
export function checkPlacement(
  ctx: ToolContext,
  doc: IdmlDocument,
  rect: Rect,
  target: PlacementTarget,
  what: string,
): string[] {
  requireSize(ctx, rect, what);
  return placementWarnings(ctx, rect, pageBoxFor(doc, target), what);
}

/** Refuses a length that has to be positive (a width, a height, a radius). */
export function requirePositive(ctx: ToolContext, value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value)) throw new Error(`The ${name} is not a number.`);
  if (value <= 0) throw new Error(`The ${name} has to be positive, but I was given ${len(ctx, value)}.`);
  if (value > MAX_DIMENSION_PT)
    throw new Error(
      `${len(ctx, value)} is bigger than InDesign allows for a ${name} (at most ${len(ctx, MAX_DIMENSION_PT)}).`,
    );
}

/** Notes about where an item ended up after it was moved or resized. */
export function fitNotes(
  ctx: ToolContext,
  doc: IdmlDocument,
  info: { bounds?: Rect; page?: number; onMaster?: string; name?: string; id: string; type: string },
  what?: string,
): string[] {
  if (!info.bounds) return [];
  const target: PlacementTarget =
    info.page !== undefined ? { page: info.page } : info.onMaster ? { master: info.onMaster } : {};
  if (target.page === undefined && target.master === undefined) return [];
  return placementWarnings(
    ctx,
    info.bounds,
    pageBoxFor(doc, target),
    what ?? `${info.type}${info.name ? ` "${info.name}"` : ''}`,
  );
}

/** Appends notes to a tool's answer text. */
export function withNotes(text: string, notes: string[]): string {
  return notes.length ? `${text}\n${notes.map((n) => `Note: ${n}`).join('\n')}` : text;
}
