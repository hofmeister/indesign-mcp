import * as z from 'zod';
import { itemSummary } from '../idml/inspect.ts';
import { findItem } from '../idml/items.ts';
import { listLayers } from '../idml/layers.ts';
import { groupItems, stepAndRepeat, ungroupItems } from '../idml/shapes.ts';
import { applyObjectStyle } from '../idml/styles.ts';
import { fitNotes, withNotes } from './checks.ts';
import type { ToolContext } from './context.ts';
import type { ToolRegistry } from './registry.ts';
import { documentParam, itemParam, lengthParam, ok, pageParam, run, toolInput } from './shared.ts';

export function registerShapeTools(reg: ToolRegistry, ctx: ToolContext): void {
  const describe = (doc: import('../idml/document.ts').IdmlDocument, id: string) => {
    const found = findItem(doc, id);
    const layers = new Map(listLayers(doc).map((l) => [l.id, l.name]));
    return itemSummary(found.info, ctx.unit, layers);
  };

  reg.tool(
    'group_items',
    {
      title: 'Group items',
      description: 'Groups several items on the same page so they can be moved, copied and styled together.',
      inputSchema: toolInput({
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

  reg.tool(
    'ungroup_items',
    {
      title: 'Ungroup',
      description: 'Dissolves a group; its items stay where they are.',
      inputSchema: toolInput({ document: documentParam, group: itemParam, page: pageParam.optional() }),
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

  reg.tool(
    'step_and_repeat',
    {
      title: 'Step and repeat',
      description:
        "Copies an item into a grid, like InDesign's Step and Repeat — useful for labels, tickets or a photo grid.",
      inputSchema: toolInput({
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
        // warn once if any copy landed off the page
        const strays = created
          .map((el) => findItem(doc, el.getAttribute('Self')!))
          .flatMap((c) => fitNotes(ctx, doc, c.info, 'one of the copies'));
        const notes = strays.length ? [strays[0]!] : [];
        return ok(
          withNotes(`Created ${created.length} copies in a ${args.rows} × ${args.columns} grid.`, notes),
          { created: created.length, notes },
        );
      }),
  );

  reg.tool(
    'apply_object_style',
    {
      title: 'Apply object style',
      description:
        'Applies an object style to an item (fill, stroke, corners, text frame options and paragraph style in one go).',
      inputSchema: toolInput({
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
