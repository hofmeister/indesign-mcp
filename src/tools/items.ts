import * as z from 'zod';
import { itemSummary } from '../idml/inspect.ts';
import {
  arrangeItem,
  createLine,
  createOval,
  createRectangle,
  createTextFrame,
  deleteItem,
  duplicateItem,
  findItem,
  itemInfo,
  itemSpreadBounds,
  listItems,
  moveItemTo,
  renameItem,
  resizeItem,
  rotateItem,
  setCornerRadius,
  setFill,
  setOpacity,
  setStroke,
  setTextFrameOptions,
  type Target,
  translateItem,
} from '../idml/items.ts';
import { findLayer, listLayers } from '../idml/layers.ts';
import { findPage, listPages } from '../idml/pages.ts';
import { createFreePath, createPolygon } from '../idml/shapes.ts';
import { styleSelf } from '../idml/styles.ts';
import type { LengthInput } from '../idml/units.ts';
import {
  attr,
  children,
  type Element,
  firstChild,
  fragment,
  propertiesOf,
  removeElement,
  setAttrs,
} from '../idml/xml.ts';
import {
  checkPlacement,
  fitNotes,
  pageBoxFor,
  placementWarnings,
  requireLine,
  requirePositive,
  withNotes,
} from './checks.ts';
import type { ToolContext } from './context.ts';
import type { ToolRegistry } from './registry.ts';
import {
  colorParam,
  documentParam,
  itemParam,
  lengthParam,
  ok,
  pageParam,
  paragraphInput,
  run,
  toolInput,
} from './shared.ts';

const targetParams = {
  page: pageParam.optional().describe('Page to place the item on (default 1). Ignored when master is given.'),
  master: z
    .string()
    .optional()
    .describe('Put the item on this master page instead of a document page, e.g. "A-Master".'),
};

const placement = {
  x: lengthParam.describe('Distance from the left edge of the page.'),
  y: lengthParam.describe('Distance from the top edge of the page.'),
  width: lengthParam,
  height: lengthParam,
};

const appearance = {
  name: z.string().optional().describe('A name to refer to the item later, e.g. "Headline".'),
  layer: z.string().optional().describe('Layer name (default: the active layer).'),
  fill: colorParam.optional(),
  stroke: colorParam.optional(),
  strokeWeight: z.number().min(0).max(1000).optional().describe('Stroke weight in points.'),
  rotation: z.number().min(-360).max(360).optional().describe('Rotation in degrees (counter-clockwise).'),
};

interface ShapeArgs {
  document: string;
  shape: 'rectangle' | 'ellipse' | 'line' | 'polygon' | 'path';
  page?: number | string;
  master?: string;
  x?: LengthInput;
  y?: LengthInput;
  width?: LengthInput;
  height?: LengthInput;
  x1?: LengthInput;
  y1?: LengthInput;
  x2?: LengthInput;
  y2?: LengthInput;
  points?: { x: LengthInput; y: LengthInput }[];
  closed?: boolean;
  smooth?: boolean;
  sides?: number;
  starInset?: number;
  cornerRadius?: LengthInput;
  strokeType?: string;
  name?: string;
  layer?: string;
  fill?: string;
  stroke?: string;
  strokeWeight?: number;
  rotation?: number;
}

function target(args: { page?: number | string; master?: string }): Target {
  return args.master ? { master: args.master } : { page: args.page ?? 1 };
}

export function registerItemTools(reg: ToolRegistry, ctx: ToolContext): void {
  const describe = (doc: import('../idml/document.ts').IdmlDocument, el: Element) => {
    const found = findItem(doc, attr(el, 'Self')!);
    const layers = new Map(listLayers(doc).map((l) => [l.id, l.name]));
    return itemSummary(found.info, ctx.unit, layers);
  };

  reg.listing(
    'items',
    {
      title: 'List items',
      description:
        'Lists the items (frames, shapes, images, text) on a page or in the whole document with names, ids, positions and sizes.',
      inputSchema: toolInput({
        document: documentParam,
        page: pageParam.optional(),
        includeMasters: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ document, page, includeMasters }) =>
      run(() => {
        const doc = ctx.open(document);
        const layers = new Map(listLayers(doc).map((l) => [l.id, l.name]));
        const items = listItems(doc, { page, includeMasters }).map((i) => ({
          page: i.page,
          master: i.onMaster,
          ...itemSummary(i, ctx.unit, layers),
        }));
        const lines = items.map(
          (i) =>
            `${i.master ? `[master ${i.master}] ` : `p${i.page ?? '?'} `}${i.type}${i.name ? ` "${i.name}"` : ''} [${i.id}] ${i.position}, ${i.size}${i.tables ? ` (${i.tables} table${i.tables > 1 ? 's' : ''})` : ''}${i.text !== undefined ? `: "${i.text.slice(0, 60)}"` : ''}${i.image ? ` (${i.image})` : ''}`,
        );
        return ok(lines.join('\n') || 'No items', { items });
      }),
  );

  reg.tool(
    'add_text_frame',
    {
      title: 'Add text frame',
      description:
        'Adds a text frame with text to a page. Positions are measured from the top-left corner of the page. Paragraphs are separated by newlines; **bold** and *italic* markup is supported. Give it a name so you can edit it later.',
      inputSchema: toolInput({
        document: documentParam,
        ...targetParams,
        ...placement,
        text: z.string().optional().describe('The text. Newlines start new paragraphs.'),
        paragraphs: z
          .array(paragraphInput)
          .optional()
          .describe('Paragraphs with their own styles, instead of `text`.'),
        paragraphStyle: z.string().optional().describe('Paragraph style name to apply to all paragraphs.'),
        columns: z.number().int().min(1).max(20).optional(),
        gutter: lengthParam.optional(),
        inset: lengthParam.optional().describe('Inset spacing on all sides.'),
        verticalJustification: z.enum(['top', 'center', 'bottom', 'justify']).optional(),
        autoSize: z
          .enum(['off', 'height', 'width', 'both'])
          .optional()
          .describe('Auto-size the frame to its text.'),
        ...appearance,
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const notes = checkPlacement(ctx, doc, ctx.rect(args), args, 'text frame');
        const el = createTextFrame(doc, target(args), {
          rect: ctx.rect(args),
          text: args.text,
          paragraphs: args.paragraphs?.map((p) => ({
            text: p.text,
            style: p.style ? styleSelf(doc, 'ParagraphStyle', p.style) : undefined,
          })),
          paragraphStyle: args.paragraphStyle
            ? styleSelf(doc, 'ParagraphStyle', args.paragraphStyle)
            : undefined,
          name: args.name,
          layer: args.layer,
          fill: args.fill,
          stroke: args.stroke,
          strokeWeight: args.strokeWeight,
          rotation: args.rotation,
          columns: args.columns,
          gutter: ctx.ptOpt(args.gutter),
          inset: ctx.ptOpt(args.inset),
          verticalJustification: args.verticalJustification,
          autoSize: args.autoSize,
        });
        ctx.save(doc);
        const s = describe(doc, el);
        return ok(
          withNotes(
            `Added text frame${s.name ? ` "${s.name}"` : ''} [${s.id}] ${s.position}, ${s.size}${args.master ? ` on master ${args.master}` : ` on page ${args.page ?? 1}`}.`,
            notes,
          ),
          { item: s, notes },
        );
      }),
  );

  /**
   * The five shapes behind `add_shape`. They share a target, an appearance and a placement check;
   * only the geometry differs, which is why they are one tool rather than five.
   */
  const addShape = (args: ShapeArgs) => {
    const doc = ctx.open(args.document);
    const where = target(args);
    const common = {
      name: args.name,
      layer: args.layer,
      stroke: args.stroke,
      strokeWeight: args.strokeWeight,
      rotation: args.rotation,
    };

    const needBox = (): { x: number; y: number; width: number; height: number } => {
      for (const k of ['x', 'y', 'width', 'height'] as const)
        if (args[k] === undefined) throw new Error(`A ${args.shape} needs x, y, width and height.`);
      return ctx.rect(args as { x: LengthInput; y: LengthInput; width: LengthInput; height: LengthInput });
    };

    if (args.shape === 'line') {
      for (const k of ['x1', 'y1', 'x2', 'y2'] as const)
        if (args[k] === undefined) throw new Error('A line needs x1, y1, x2 and y2.');
      const from = { x: ctx.pt(args.x1!), y: ctx.pt(args.y1!) };
      const to = { x: ctx.pt(args.x2!), y: ctx.pt(args.y2!) };
      requireLine(ctx, from, to);
      const box = {
        x: Math.min(from.x, to.x),
        y: Math.min(from.y, to.y),
        width: Math.abs(to.x - from.x),
        height: Math.abs(to.y - from.y),
      };
      const notes = placementWarnings(ctx, box, pageBoxFor(doc, args), 'line');
      const el = createLine(doc, where, {
        from,
        to,
        ...common,
        stroke: args.stroke ?? 'Black',
        strokeWeight: args.strokeWeight ?? 1,
      });
      if (args.strokeType) setStroke(doc, el, { type: args.strokeType });
      ctx.save(doc);
      const s2 = describe(doc, el);
      return ok(
        withNotes(
          `Added line${s2.name ? ` "${s2.name}"` : ''} [${s2.id}] ${s2.position}, ${s2.size}.`,
          notes,
        ),
        {
          item: s2,
          notes,
        },
      );
    }

    if (args.shape === 'path') {
      if (!args.points?.length) throw new Error('A path needs at least two points.');
      const points = args.points.map((pt) => ({ x: ctx.pt(pt.x), y: ctx.pt(pt.y) }));
      if (points.some((pt) => !Number.isFinite(pt.x) || !Number.isFinite(pt.y)))
        throw new Error('Every point needs a numeric x and y.');
      const xs = points.map((pt) => pt.x);
      const ys = points.map((pt) => pt.y);
      const notes = placementWarnings(
        ctx,
        {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        },
        pageBoxFor(doc, args),
        'path',
      );
      const el = createFreePath(doc, where, {
        points,
        open: !args.closed,
        smooth: args.smooth,
        ...common,
        fill: args.fill ?? (args.closed ? 'Black' : 'none'),
        stroke: args.stroke ?? (args.closed ? undefined : 'Black'),
        strokeWeight: args.strokeWeight ?? (args.closed ? undefined : 1),
      });
      ctx.save(doc);
      const s2 = describe(doc, el);
      return ok(
        withNotes(
          `Added path${s2.name ? ` "${s2.name}"` : ''} [${s2.id}] with ${points.length} points, ${s2.position}, ${s2.size}.`,
          notes,
        ),
        { item: s2, notes },
      );
    }

    const rect = needBox();
    const kind = args.shape === 'polygon' && args.starInset ? 'star' : args.shape;
    const notes = checkPlacement(ctx, doc, rect, args, kind);
    let el: Element;
    if (args.shape === 'rectangle') {
      el = createRectangle(doc, where, { rect, ...common, fill: args.fill });
      if (args.cornerRadius !== undefined) setCornerRadius(el, ctx.pt(args.cornerRadius));
    } else if (args.shape === 'ellipse') {
      el = createOval(doc, where, { rect, ...common, fill: args.fill });
    } else {
      el = createPolygon(doc, where, {
        rect,
        sides: args.sides ?? 6,
        starInset: args.starInset,
        ...common,
        fill: args.fill ?? 'Black',
      });
    }
    ctx.save(doc);
    const s2 = describe(doc, el);
    return ok(
      withNotes(
        `Added ${kind}${s2.name ? ` "${s2.name}"` : ''} [${s2.id}] ${s2.position}, ${s2.size}.`,
        notes,
      ),
      { item: s2, notes },
    );
  };

  reg.tool(
    'add_shape',
    {
      title: 'Add a shape',
      description:
        'Adds a rectangle, ellipse, line, polygon/star or free path. Rectangles, ellipses and polygons fill the box given by x/y/width/height; a line runs from x1/y1 to x2/y2; a path follows `points`. Filled with Black unless `fill` says otherwise (use "none" for an empty frame). To place a picture, use place_image instead.',
      inputSchema: toolInput({
        document: documentParam,
        shape: z.enum(['rectangle', 'ellipse', 'line', 'polygon', 'path']).describe('Which shape to draw.'),
        ...targetParams,
        x: lengthParam.optional().describe('Box left edge. Rectangle, ellipse and polygon.'),
        y: lengthParam.optional().describe('Box top edge. Rectangle, ellipse and polygon.'),
        width: lengthParam.optional().describe('Box width. Rectangle, ellipse and polygon.'),
        height: lengthParam.optional().describe('Box height. Rectangle, ellipse and polygon.'),
        x1: lengthParam.optional().describe('Line start x.'),
        y1: lengthParam.optional().describe('Line start y.'),
        x2: lengthParam.optional().describe('Line end x.'),
        y2: lengthParam.optional().describe('Line end y.'),
        points: z
          .array(z.object({ x: lengthParam, y: lengthParam }))
          .min(2)
          .optional()
          .describe('Path only: points from the top-left corner of the page.'),
        closed: z.boolean().optional().describe('Path only: close it into a shape (default false).'),
        smooth: z.boolean().optional().describe('Path only: curve through the points.'),
        sides: z
          .number()
          .int()
          .min(3)
          .max(100)
          .optional()
          .describe('Polygon only: sides or star points (default 6).'),
        starInset: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Polygon only: star point depth in percent - 0 = polygon, 50 = classic star.'),
        cornerRadius: lengthParam.optional().describe('Rectangle only: rounded corners.'),
        strokeType: z
          .string()
          .optional()
          .describe('Line only: solid, dashed, dotted, thick-thin, thin-thick, wavy.'),
        ...appearance,
      }),
    },
    async (args) => run(() => addShape(args)),
  );

  reg.variant(
    'edit_item',
    'move',
    {
      title: 'Move item',
      description: 'Moves an item to a position (from the top-left of its page) or by an offset (dx/dy).',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional().describe('Disambiguates items with the same name.'),
        x: lengthParam.optional(),
        y: lengthParam.optional(),
        dx: lengthParam.optional(),
        dy: lengthParam.optional(),
        toPage: pageParam.optional().describe('Move the item to another page (keeps x/y unless given).'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        if (args.toPage !== undefined) {
          const dest = findPage(doc, args.toPage);
          const b = found.info.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
          const el = found.element;
          const destSpread = doc.findBySelf(dest.spreadId)?.element;
          if (!destSpread) throw new Error('Destination spread not found');
          if (destSpread !== found.container) {
            removeElement(el);
            const { insertAfter } = require('../idml/xml.ts') as typeof import('../idml/xml.ts');
            const imported = destSpread.ownerDocument!.importNode(el, true) as Element;
            insertAfter(destSpread, imported);
            moveItemTo(imported, {
              x: dest.origin.x + (args.x !== undefined ? ctx.pt(args.x) : b.x),
              y: dest.origin.y + (args.y !== undefined ? ctx.pt(args.y) : b.y),
            });
          } else {
            moveItemTo(el, {
              x: dest.origin.x + (args.x !== undefined ? ctx.pt(args.x) : b.x),
              y: dest.origin.y + (args.y !== undefined ? ctx.pt(args.y) : b.y),
            });
          }
        } else if (args.dx !== undefined || args.dy !== undefined) {
          translateItem(found.element, ctx.ptOpt(args.dx) ?? 0, ctx.ptOpt(args.dy) ?? 0);
        } else if (args.x !== undefined || args.y !== undefined) {
          const page = found.info.page !== undefined ? findPage(doc, found.info.page) : undefined;
          const origin = page?.origin ?? { x: 0, y: 0 };
          const b = found.info.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
          moveItemTo(found.element, {
            x: origin.x + (args.x !== undefined ? ctx.pt(args.x) : b.x),
            y: origin.y + (args.y !== undefined ? ctx.pt(args.y) : b.y),
          });
        } else throw new Error('Give x/y, dx/dy or toPage');
        ctx.save(doc);
        const moved = findItem(doc, found.info.id);
        const s = describe(doc, moved.element);
        const notes = fitNotes(ctx, doc, moved.info);
        return ok(withNotes(`Moved ${s.type}${s.name ? ` "${s.name}"` : ''} to ${s.position}.`, notes), {
          item: s,
          notes,
        });
      }),
  );

  reg.variant(
    'edit_item',
    'resize',
    {
      title: 'Resize item',
      description: 'Changes the width and/or height of an item, keeping its top-left corner in place.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        width: lengthParam.optional(),
        height: lengthParam.optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        requirePositive(ctx, ctx.ptOpt(args.width), 'width');
        requirePositive(ctx, ctx.ptOpt(args.height), 'height');
        resizeItem(found.element, ctx.ptOpt(args.width), ctx.ptOpt(args.height));
        ctx.save(doc);
        const resized = findItem(doc, found.info.id);
        const s = describe(doc, resized.element);
        const notes = fitNotes(ctx, doc, resized.info);
        return ok(withNotes(`Resized to ${s.size}.`, notes), { item: s, notes });
      }),
  );

  reg.variant(
    'edit_item',
    'rotate',
    {
      title: 'Rotate item',
      description: 'Sets the rotation of an item in degrees (counter-clockwise, around its center).',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        degrees: z.number().min(-360).max(360),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        rotateItem(found.element, args.degrees);
        ctx.save(doc);
        return ok(`Rotated to ${args.degrees}°.`, { item: describe(doc, found.element) });
      }),
  );

  reg.tool(
    'set_appearance',
    {
      title: 'Fill, stroke, corners, opacity',
      description: 'Changes fill color, stroke (color, weight, type), corner radius and opacity of an item.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        fill: colorParam.optional(),
        fillTint: z.number().min(0).max(100).optional(),
        stroke: colorParam.optional(),
        strokeWeight: z.number().min(0).optional(),
        strokeType: z.string().optional(),
        strokeAlignment: z.enum(['center', 'inside', 'outside']).optional(),
        cornerRadius: lengthParam.optional(),
        cornerShape: z.enum(['rounded', 'inverse-rounded', 'bevel', 'inset', 'fancy', 'none']).optional(),
        opacity: z.number().min(0).max(100).optional(),
        blendMode: z.string().optional().describe('Normal, Multiply, Screen, Overlay, Darken, Lighten…'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        const el = found.element;
        if (args.fill !== undefined) setFill(doc, el, args.fill, args.fillTint);
        if (
          args.stroke !== undefined ||
          args.strokeWeight !== undefined ||
          args.strokeType ||
          args.strokeAlignment
        )
          setStroke(doc, el, {
            swatch: args.stroke,
            weight: args.strokeWeight,
            type: args.strokeType,
            alignment: args.strokeAlignment,
          });
        if (args.cornerRadius !== undefined)
          setCornerRadius(el, ctx.pt(args.cornerRadius), args.cornerShape ?? 'rounded');
        if (args.opacity !== undefined || args.blendMode) setOpacity(el, args.opacity ?? 100, args.blendMode);
        ctx.save(doc);
        return ok('Appearance updated.', { item: describe(doc, el) });
      }),
  );

  reg.variant(
    'edit_item',
    'delete',
    {
      title: 'Delete item',
      description: 'Deletes an item (and its text story if it was a text frame).',
      inputSchema: toolInput({ document: documentParam, item: itemParam, page: pageParam.optional() }),
      annotations: { destructiveHint: true },
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        deleteItem(doc, found.element);
        ctx.save(doc);
        return ok(
          `Deleted ${found.info.type}${found.info.name ? ` "${found.info.name}"` : ''} [${found.info.id}].`,
        );
      }),
  );

  reg.variant(
    'edit_item',
    'duplicate',
    {
      title: 'Duplicate item',
      description:
        'Duplicates an item, offset by dx/dy (default 5mm) or onto another page at the same position.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        dx: lengthParam.optional(),
        dy: lengthParam.optional(),
        toPage: pageParam.optional(),
        name: z.string().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        let clone: Element;
        if (args.toPage !== undefined) {
          const dest = findPage(doc, args.toPage);
          clone = duplicateItem(doc, found, { x: 0, y: 0 });
          const destSpread = doc.findBySelf(dest.spreadId)?.element;
          if (!destSpread) throw new Error('Destination spread not found');
          const b = found.info.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
          if (destSpread !== found.container) {
            removeElement(clone);
            const { insertAfter } = require('../idml/xml.ts') as typeof import('../idml/xml.ts');
            clone = destSpread.ownerDocument!.importNode(clone, true) as Element;
            insertAfter(destSpread, clone);
          }
          moveItemTo(clone, {
            x: dest.origin.x + b.x + (ctx.ptOpt(args.dx) ?? 0),
            y: dest.origin.y + b.y + (ctx.ptOpt(args.dy) ?? 0),
          });
        } else {
          clone = duplicateItem(doc, found, {
            x: ctx.ptOpt(args.dx) ?? ctx.pt(5),
            y: ctx.ptOpt(args.dy) ?? ctx.pt(5),
          });
        }
        if (args.name) renameItem(clone, args.name);
        ctx.save(doc);
        const s = describe(doc, clone);
        const copy = findItem(doc, attr(clone, 'Self')!);
        const notes = fitNotes(ctx, doc, copy.info, 'the copy');
        return ok(
          withNotes(`Duplicated as ${s.type}${s.name ? ` "${s.name}"` : ''} [${s.id}] ${s.position}.`, notes),
          { item: s, notes },
        );
      }),
  );

  reg.variant(
    'edit_item',
    'rename',
    {
      title: 'Rename item',
      description: 'Gives an item a name (or removes it).',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        name: z.string().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        renameItem(found.element, args.name);
        ctx.save(doc);
        return ok(args.name ? `Renamed to "${args.name}".` : 'Name removed.');
      }),
  );

  reg.variant(
    'edit_item',
    'arrange',
    {
      title: 'Arrange (z-order)',
      description:
        'Brings an item to the front / sends it to the back / one step forward or backward within its layer order.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        action: z.enum(['front', 'back', 'forward', 'backward']),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        arrangeItem(found.element, args.action);
        ctx.save(doc);
        return ok(`Moved ${args.action}.`);
      }),
  );

  reg.variant(
    'edit_item',
    'layer',
    {
      title: 'Move item to layer',
      description: 'Moves an item to another layer.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        layer: z.string(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        const layer = findLayer(doc, args.layer);
        if (!layer) throw new Error(`Layer "${args.layer}" not found`);
        found.element.setAttribute('ItemLayer', attr(layer, 'Self')!);
        ctx.save(doc);
        return ok(`Moved to layer "${attr(layer, 'Name')}".`);
      }),
  );

  reg.variant(
    'edit_item',
    'align',
    {
      title: 'Align items',
      description:
        'Aligns items to the page or page margins: left, center, right, top, middle, bottom. Also distributes several items evenly.',
      inputSchema: toolInput({
        document: documentParam,
        items: z.array(itemParam).min(1),
        page: pageParam.optional(),
        to: z.enum(['page', 'margins']).default('page'),
        horizontal: z.enum(['left', 'center', 'right']).optional(),
        vertical: z.enum(['top', 'middle', 'bottom']).optional(),
        distribute: z
          .enum(['horizontal', 'vertical'])
          .optional()
          .describe('Distribute the items evenly between the outermost ones.'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const founds = args.items.map((i) => findItem(doc, i, args.page));
        const pageIndex = founds[0]!.info.page;
        if (pageIndex === undefined) throw new Error('Items must be on a document page');
        const page = findPage(doc, pageIndex);
        const area =
          args.to === 'margins'
            ? {
                x: page.origin.x + page.margins.left,
                y: page.origin.y + page.margins.top,
                width: page.width - page.margins.left - page.margins.right,
                height: page.height - page.margins.top - page.margins.bottom,
              }
            : { x: page.origin.x, y: page.origin.y, width: page.width, height: page.height };
        for (const f of founds) {
          const b = itemSpreadBounds(f.element);
          if (!b) continue;
          let x = b.x;
          let y = b.y;
          if (args.horizontal === 'left') x = area.x;
          if (args.horizontal === 'center') x = area.x + (area.width - b.width) / 2;
          if (args.horizontal === 'right') x = area.x + area.width - b.width;
          if (args.vertical === 'top') y = area.y;
          if (args.vertical === 'middle') y = area.y + (area.height - b.height) / 2;
          if (args.vertical === 'bottom') y = area.y + area.height - b.height;
          moveItemTo(f.element, { x, y });
        }
        if (args.distribute && founds.length > 2) {
          const sorted = founds
            .map((f) => ({ f, b: itemSpreadBounds(f.element)! }))
            .sort((a, b) => (args.distribute === 'horizontal' ? a.b.x - b.b.x : a.b.y - b.b.y));
          const first = sorted[0]!.b;
          const last = sorted.at(-1)!.b;
          if (args.distribute === 'horizontal') {
            const total = last.x + last.width - first.x;
            const widths = sorted.reduce((s, o) => s + o.b.width, 0);
            const gap = (total - widths) / (sorted.length - 1);
            let x = first.x;
            for (const o of sorted) {
              moveItemTo(o.f.element, { x, y: o.b.y });
              x += o.b.width + gap;
            }
          } else {
            const total = last.y + last.height - first.y;
            const heights = sorted.reduce((s, o) => s + o.b.height, 0);
            const gap = (total - heights) / (sorted.length - 1);
            let y = first.y;
            for (const o of sorted) {
              moveItemTo(o.f.element, { x: o.b.x, y });
              y += o.b.height + gap;
            }
          }
        }
        ctx.save(doc);
        return ok(`Aligned ${founds.length} item(s).`);
      }),
  );

  reg.tool(
    'set_text_frame_options',
    {
      title: 'Text frame options',
      description: 'Columns, gutter, inset spacing, vertical justification and auto-size of a text frame.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        columns: z.number().int().min(1).max(20).optional(),
        gutter: lengthParam.optional(),
        inset: lengthParam.optional(),
        verticalJustification: z.enum(['top', 'center', 'bottom', 'justify']).optional(),
        autoSize: z.enum(['off', 'height', 'width', 'both']).optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        if (found.element.tagName !== 'TextFrame') throw new Error(`"${args.item}" is not a text frame`);
        setTextFrameOptions(found.element, {
          columns: args.columns,
          gutter: ctx.ptOpt(args.gutter),
          inset: ctx.ptOpt(args.inset),
          verticalJustification: args.verticalJustification,
          autoSize: args.autoSize,
        });
        ctx.save(doc);
        return ok('Text frame options updated.');
      }),
  );

  reg.tool(
    'set_text_wrap',
    {
      title: 'Text wrap',
      description: 'Makes text in other frames flow around this item (bounding box wrap) or turns wrap off.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        mode: z.enum(['none', 'bounding-box', 'jump', 'next-column']),
        offset: lengthParam.optional().describe('Distance between item and text.'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        const el = found.element;
        let pref = firstChild(el, 'TextWrapPreference');
        if (!pref) {
          pref = fragment(
            el.ownerDocument!,
            `<TextWrapPreference Inverse="false" ApplyToMasterPageOnly="false" TextWrapSide="BothSides" TextWrapMode="None"><Properties><TextWrapOffset Top="0" Left="0" Bottom="0" Right="0"/></Properties></TextWrapPreference>`,
          );
          el.appendChild(pref);
        }
        pref.setAttribute(
          'TextWrapMode',
          {
            none: 'None',
            'bounding-box': 'BoundingBoxTextWrap',
            jump: 'JumpObjectTextWrap',
            'next-column': 'NextColumnTextWrap',
          }[args.mode],
        );
        if (args.offset !== undefined) {
          const o = ctx.pt(args.offset);
          const off = firstChild(propertiesOf(pref, true), 'TextWrapOffset');
          if (off) setAttrs(off, { Top: o, Left: o, Bottom: o, Right: o });
        }
        ctx.save(doc);
        return ok(`Text wrap set to ${args.mode}.`);
      }),
  );

  reg.variant(
    'edit_item',
    'fit',
    {
      title: 'Fit frame to content',
      description:
        'For text frames: turns on auto-size so the frame grows/shrinks with its text (height, or both). For image frames use set_image_fit.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        mode: z.enum(['height', 'both']).default('height'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.item, args.page);
        if (found.element.tagName !== 'TextFrame')
          throw new Error('edit_item fit works on text frames; use set_image_fit for pictures');
        setTextFrameOptions(found.element, { autoSize: args.mode });
        ctx.save(doc);
        return ok(`Frame will auto-size (${args.mode}).`);
      }),
  );

  void itemInfo;
  void children;
  void listPages;
}
