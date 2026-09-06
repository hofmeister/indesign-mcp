import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { itemSummary } from '../idml/inspect.ts';
import { findItem } from '../idml/items.ts';
import { listLayers } from '../idml/layers.ts';
import { createFreePath, createPolygon, groupItems, stepAndRepeat, ungroupItems } from '../idml/shapes.ts';
import { applyObjectStyle } from '../idml/styles.ts';
import type { ToolContext } from './context.ts';
import { colorParam, documentParam, itemParam, lengthParam, ok, pageParam, run } from './shared.ts';

const targetParams = {
  page: pageParam.optional().describe('Page to place the item on (default 1).'),
  master: z.string().optional().describe('Put the item on this master page instead.'),
};

const appearance = {
  name: z.string().optional().describe('A name to refer to the item later.'),
  layer: z.string().optional(),
  fill: colorParam.optional(),
  stroke: colorParam.optional(),
  strokeWeight: z.number().min(0).optional(),
  rotation: z.number().optional(),
};

export function registerShapeTools(server: McpServer, ctx: ToolContext): void {
  const describe = (doc: import('../idml/document.ts').IdmlDocument, id: string) => {
    const found = findItem(doc, id);
    const layers = new Map(listLayers(doc).map((l) => [l.id, l.name]));
    return itemSummary(found.info, ctx.unit, layers);
  };

  server.registerTool(
    'add_polygon',
    {
      title: 'Add polygon or star',
      description: 'Adds a regular polygon (triangle, pentagon, hexagon…) or a star inside the given box.',
      inputSchema: z.object({
        document: documentParam,
        ...targetParams,
        x: lengthParam,
        y: lengthParam,
        width: lengthParam,
        height: lengthParam,
        sides: z.number().int().min(3).max(100).default(6).describe('Number of sides (or star points).'),
        starInset: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Star point depth in percent: 0 = polygon, 50 = classic star.'),
        ...appearance,
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const el = createPolygon(doc, args.master ? { master: args.master } : { page: args.page ?? 1 }, {
          rect: ctx.rect(args),
          sides: args.sides,
          starInset: args.starInset,
          name: args.name,
          layer: args.layer,
          fill: args.fill ?? 'Black',
          stroke: args.stroke,
          strokeWeight: args.strokeWeight,
          rotation: args.rotation,
        });
        ctx.save(doc);
        const s = describe(doc, el.getAttribute('Self')!);
        return ok(
          `Added ${args.starInset ? 'star' : 'polygon'}${s.name ? ` "${s.name}"` : ''} [${s.id}] ${s.position}, ${s.size}.`,
          { item: s },
        );
      }),
  );

  server.registerTool(
    'add_path',
    {
      title: 'Add a free path',
      description:
        'Draws a path through a list of points (straight or smooth), open like a line or closed like a shape.',
      inputSchema: z.object({
        document: documentParam,
        ...targetParams,
        points: z
          .array(z.object({ x: lengthParam, y: lengthParam }))
          .min(2)
          .describe('Points measured from the top-left corner of the page.'),
        closed: z.boolean().optional().describe('Close the path into a shape (default false).'),
        smooth: z.boolean().optional().describe('Curve through the points instead of straight segments.'),
        ...appearance,
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const el = createFreePath(doc, args.master ? { master: args.master } : { page: args.page ?? 1 }, {
          points: args.points.map((p) => ({ x: ctx.pt(p.x), y: ctx.pt(p.y) })),
          open: !args.closed,
          smooth: args.smooth,
          name: args.name,
          layer: args.layer,
          fill: args.fill ?? (args.closed ? 'Black' : 'none'),
          stroke: args.stroke ?? (args.closed ? undefined : 'Black'),
          strokeWeight: args.strokeWeight ?? (args.closed ? undefined : 1),
          rotation: args.rotation,
        });
        ctx.save(doc);
        const s = describe(doc, el.getAttribute('Self')!);
        return ok(
          `Added path${s.name ? ` "${s.name}"` : ''} [${s.id}] with ${args.points.length} points, ${s.position}, ${s.size}.`,
          { item: s },
        );
      }),
  );

  server.registerTool(
    'group_items',
    {
      title: 'Group items',
      description: 'Groups several items on the same page so they can be moved, copied and styled together.',
      inputSchema: z.object({
        document: documentParam,
        items: z.array(itemParam).min(2),
        page: pageParam.optional(),
        name: z.string().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = args.items.map((i) => findItem(doc, i, args.page));
        const group = groupItems(doc, found, args.name);
        ctx.save(doc);
        const s = describe(doc, group.getAttribute('Self')!);
        return ok(
          `Grouped ${found.length} items${s.name ? ` as "${s.name}"` : ''} [${s.id}] ${s.position}, ${s.size}.`,
          { item: s },
        );
      }),
  );

  server.registerTool(
    'ungroup_items',
    {
      title: 'Ungroup',
      description: 'Dissolves a group; its items stay where they are.',
      inputSchema: z.object({ document: documentParam, group: itemParam, page: pageParam.optional() }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.group, args.page);
        if (found.element.tagName !== 'Group')
          throw new Error(`"${args.group}" is a ${found.info.type}, not a group`);
        const items = ungroupItems(doc, found.element);
        ctx.save(doc);
        return ok(`Ungrouped into ${items.length} item(s).`, {
          items: items.map((i) => describe(doc, i.getAttribute('Self')!)),
        });
      }),
  );

  server.registerTool(
    'step_and_repeat',
    {
      title: 'Step and repeat',
      description:
        "Copies an item into a grid, like InDesign's Step and Repeat — useful for labels, tickets or a photo grid.",
      inputSchema: z.object({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        rows: z.number().int().min(1).max(50).default(1),
        columns: z.number().int().min(1).max(50).default(1),
        offsetX: lengthParam
          .optional()
          .describe('Horizontal distance between copies (default: the item width plus a small gap).'),
        offsetY: lengthParam.optional(),
        name: z.string().optional().describe('Base name for the copies.'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        const created = stepAndRepeat(doc, found, {
          rows: args.rows,
          columns: args.columns,
          offsetX: ctx.ptOpt(args.offsetX),
          offsetY: ctx.ptOpt(args.offsetY),
          name: args.name,
        });
        ctx.save(doc);
        return ok(`Created ${created.length} copies in a ${args.rows} × ${args.columns} grid.`, {
          created: created.length,
        });
      }),
  );

  server.registerTool(
    'apply_object_style',
    {
      title: 'Apply object style',
      description:
        'Applies an object style to an item (fill, stroke, corners, text frame options and paragraph style in one go).',
      inputSchema: z.object({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        style: z.string(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        applyObjectStyle(doc, found.element, args.style);
        ctx.save(doc);
        return ok(`Applied object style "${args.style}".`, { item: describe(doc, found.info.id) });
      }),
  );
}
