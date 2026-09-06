import * as z from 'zod';
import { formatMatrix } from '../idml/geometry.ts';
import { masterInfos } from '../idml/inspect.ts';
import { createLayer, findLayer, listLayers } from '../idml/layers.ts';
import {
  addPages,
  documentPreference,
  findPage,
  isFacingPages,
  listPages,
  pageTransform,
  removePages,
  resolveMaster,
} from '../idml/pages.ts';
import { applyMargins } from '../idml/template.ts';
import { formatLength, PAGE_SIZES, resolvePageSize } from '../idml/units.ts';
import { attr, children, createIdPkgRef, formatNumber, setAttrs } from '../idml/xml.ts';
import type { ToolContext } from './context.ts';
import type { ToolRegistry } from './registry.ts';
import { documentParam, lengthParam, ok, pageParam, run, toolInput } from './shared.ts';
export function registerPageTools(reg: ToolRegistry, ctx: ToolContext): void {
  reg.listing(
    'pages',
    {
      title: 'List pages',
      description: 'Lists the pages with size, side (left/right), margins, columns and applied master page.',
      inputSchema: toolInput({ document: documentParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(() => {
        const doc = ctx.open(document);
        const pages = listPages(doc);
        const masters = new Map(masterInfos(doc).map((m) => [m.id, m.name]));
        const u = ctx.unit;
        const lines = pages.map(
          (p) =>
            `${p.index}. "${p.name}" ${p.side}, ${formatLength(p.width, u)} × ${formatLength(p.height, u)}, margins t${formatLength(p.margins.top, u)} b${formatLength(p.margins.bottom, u)} l${formatLength(p.margins.left, u)} r${formatLength(p.margins.right, u)}, ${p.columns.count} column(s)${p.appliedMaster ? `, master ${masters.get(p.appliedMaster) ?? p.appliedMaster}` : ''}`,
        );
        return ok(lines.join('\n') || 'No pages', {
          pages: pages.map((p) => ({
            number: p.index,
            name: p.name,
            side: p.side,
            width: formatLength(p.width, u),
            height: formatLength(p.height, u),
            master: p.appliedMaster ? masters.get(p.appliedMaster) : undefined,
          })),
        });
      }),
  );

  reg.variant(
    'edit_pages',
    'add',
    {
      title: 'Add pages',
      description:
        'Adds pages at the end of the document (new pages get the same master as the last page unless specified).',
      inputSchema: toolInput({
        document: documentParam,
        count: z.number().int().min(1).max(200).optional().describe('How many pages (default 1).'),
        master: z.string().optional().describe('Master page to apply, e.g. "A-Master", or "none".'),
      }),
    },
    async ({ document, count, master }) =>
      run(() => {
        const doc = ctx.open(document);
        const added = addPages(doc, { count, master });
        ctx.save(doc);
        return ok(
          `Added page(s) ${added.map((p) => p.index).join(', ')}. The document now has ${listPages(doc).length} pages.`,
          {
            added: added.map((p) => p.index),
            total: listPages(doc).length,
          },
        );
      }),
  );

  reg.variant(
    'edit_pages',
    'remove',
    {
      title: 'Remove pages',
      description: 'Deletes pages and everything on them.',
      inputSchema: toolInput({ document: documentParam, pages: z.array(pageParam).min(1) }),
      annotations: { destructiveHint: true },
    },
    async ({ document, pages }) =>
      run(() => {
        const doc = ctx.open(document);
        const n = removePages(doc, pages);
        ctx.save(doc);
        return ok(`Removed ${n} page(s). ${listPages(doc).length} page(s) remain.`, {
          removed: n,
          total: listPages(doc).length,
        });
      }),
  );

  reg.tool(
    'set_page_size',
    {
      title: 'Set page size',
      description: `Changes the page size of the whole document. Presets: ${Object.keys(PAGE_SIZES).join(', ')}, or give width and height. Existing items keep their position relative to the top-left corner of their page.`,
      inputSchema: toolInput({
        document: documentParam,
        pageSize: z.string().optional(),
        orientation: z.enum(['portrait', 'landscape']).optional(),
        width: lengthParam.optional(),
        height: lengthParam.optional(),
      }),
    },
    async ({ document, pageSize, orientation, width, height }) =>
      run(() => {
        const doc = ctx.open(document);
        const size = resolvePageSize(pageSize, orientation, width, height, ctx.unit);
        const dp = documentPreference(doc);
        setAttrs(dp, { PageWidth: size.width, PageHeight: size.height });
        const facing = isFacingPages(doc);
        const before = listPages(doc);
        for (const spread of doc.spreads()) {
          for (const page of children(spread, 'Page')) {
            const info = before.find((p) => p.id === attr(page, 'Self'));
            const newTransform = pageTransform(size.width, size.height, facing, info?.side ?? 'single');
            setAttrs(page, {
              GeometricBounds: `0 0 ${formatNumber(size.height)} ${formatNumber(size.width)}`,
              ItemTransform: formatMatrix(newTransform),
            });
          }
        }
        for (const master of doc.masterSpreads()) {
          const mpages = children(master, 'Page');
          mpages.forEach((page, i) => {
            const side = mpages.length === 1 ? (facing ? 'right' : 'single') : i === 0 ? 'left' : 'right';
            setAttrs(page, {
              GeometricBounds: `0 0 ${formatNumber(size.height)} ${formatNumber(size.width)}`,
              ItemTransform: formatMatrix(
                pageTransform(size.width, size.height, facing || mpages.length > 1, side),
              ),
            });
          });
        }
        // Move items so they keep their page-relative position
        const after = listPages(doc);
        for (const p of before) {
          const np = after.find((q) => q.id === p.id);
          if (!np) continue;
          const dx = np.origin.x - p.origin.x;
          const dy = np.origin.y - p.origin.y;
          if (!dx && !dy) continue;
          const spread = doc.findBySelf(p.spreadId)?.element;
          if (!spread) continue;
          for (const item of children(spread)) {
            if (['Page', 'FlattenerPreference', 'Properties'].includes(item.tagName)) continue;
            const { itemSpreadBounds, translateItem } =
              require('../idml/items.ts') as typeof import('../idml/items.ts');
            const b = itemSpreadBounds(item);
            if (!b) continue;
            const cx = b.x + b.width / 2;
            // item belonged to p if its center was inside p's old bounds
            if (cx >= p.origin.x && cx <= p.origin.x + p.width) translateItem(item, dx, dy);
          }
        }
        applyMargins(doc, {}, ctx.unit);
        ctx.save(doc);
        return ok(
          `Page size is now ${formatLength(size.width, ctx.unit)} × ${formatLength(size.height, ctx.unit)}.`,
        );
      }),
  );

  reg.tool(
    'set_margins_and_columns',
    {
      title: 'Margins and columns',
      description: 'Sets page margins and column guides for all pages, or for specific pages.',
      inputSchema: toolInput({
        document: documentParam,
        margins: z
          .union([
            lengthParam,
            z.object({
              top: lengthParam,
              bottom: lengthParam,
              inside: lengthParam.optional(),
              outside: lengthParam.optional(),
              left: lengthParam.optional(),
              right: lengthParam.optional(),
            }),
          ])
          .optional(),
        columns: z.number().int().min(1).max(20).optional(),
        gutter: lengthParam.optional(),
        pages: z
          .array(pageParam)
          .optional()
          .describe('Limit to these pages (default: all pages and masters).'),
      }),
    },
    async ({ document, margins, columns, gutter, pages }) =>
      run(() => {
        const doc = ctx.open(document);
        const refs = pages?.map((p) => findPage(doc, p).index);
        applyMargins(doc, { margins, columns, gutter }, ctx.unit, refs);
        ctx.save(doc);
        return ok('Margins and columns updated.');
      }),
  );

  reg.listing(
    'masters',
    {
      title: 'List master pages',
      description: 'Lists master pages (parent pages) with the number of items on each.',
      inputSchema: toolInput({ document: documentParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(() => {
        const masters = masterInfos(ctx.open(document));
        return ok(
          masters
            .map((m) => `${m.name} (${m.pageCount} page(s), ${m.itemCount} item(s)) [${m.id}]`)
            .join('\n') || 'No master pages',
          { masters },
        );
      }),
  );

  reg.tool(
    'apply_master',
    {
      title: 'Apply master page',
      description: 'Applies a master page (or "none") to the given pages.',
      inputSchema: toolInput({
        document: documentParam,
        master: z.string(),
        pages: z.array(pageParam).min(1),
      }),
    },
    async ({ document, master, pages }) =>
      run(() => {
        const doc = ctx.open(document);
        const id = resolveMaster(doc, master);
        for (const ref of pages) {
          const p = findPage(doc, ref);
          const el = doc.findBySelf(p.id)?.element;
          if (el) el.setAttribute('AppliedMaster', id ?? 'n');
        }
        ctx.save(doc);
        return ok(`Applied ${id ? master : 'no master'} to page(s) ${pages.join(', ')}.`);
      }),
  );

  reg.tool(
    'create_master',
    {
      title: 'Create master page',
      description:
        'Creates a new master page (parent page) by duplicating an existing one, e.g. "B-Chapter" based on "A-Master". Add items to it with add_text_frame etc. using target master.',
      inputSchema: toolInput({
        document: documentParam,
        prefix: z.string().max(4).describe('One-letter prefix, e.g. "B".'),
        name: z.string().describe('Name, e.g. "Chapter".'),
        basedOn: z
          .string()
          .optional()
          .describe('Existing master to duplicate (default: the first one). Its items are copied.'),
        keepItems: z.boolean().optional().describe('Copy the items of the source master (default true).'),
      }),
    },
    async ({ document, prefix, name, basedOn, keepItems }) =>
      run(() => {
        const doc = ctx.open(document);
        const sourceId = basedOn ? resolveMaster(doc, basedOn) : attr(doc.masterSpreads()[0]!, 'Self');
        const sourcePart = doc
          .masterSpreadParts()
          .find((p) => attr(children(doc.xml(p).documentElement, 'MasterSpread')[0]!, 'Self') === sourceId);
        if (!sourcePart) throw new Error('Source master not found');
        const id = doc.newId();
        const part = `MasterSpreads/MasterSpread_${id}.xml`;
        const partDoc = doc.newPartDocument('MasterSpread');
        const source = children(doc.xml(sourcePart).documentElement, 'MasterSpread')[0]!;
        const clone = partDoc.importNode(source, true) as import('../idml/xml.ts').Element;
        setAttrs(clone, { Self: id, Name: `${prefix}-${name}`, NamePrefix: prefix, BaseName: name });
        for (const el of Array.from(clone.getElementsByTagName('*')) as import('../idml/xml.ts').Element[]) {
          if (el.hasAttribute('Self')) el.setAttribute('Self', doc.newId());
          if (el.tagName === 'Page') el.setAttribute('Name', prefix);
        }
        if (keepItems === false) {
          for (const el of children(clone))
            if (!['Page', 'Properties', 'FlattenerPreference'].includes(el.tagName)) clone.removeChild(el);
        } else {
          // stories of copied text frames must be duplicated
          const { duplicateStoriesOf } = require('../idml/masters.ts') as typeof import('../idml/masters.ts');
          duplicateStoriesOf(doc, clone);
        }
        partDoc.documentElement!.appendChild(partDoc.createTextNode('\n\t'));
        partDoc.documentElement!.appendChild(clone);
        partDoc.documentElement!.appendChild(partDoc.createTextNode('\n'));
        doc.addXmlPart(part, partDoc);
        const ref = createIdPkgRef(doc.designmap, 'MasterSpread', part);
        const refs = children(doc.root).filter((c) => c.tagName === 'idPkg:MasterSpread');
        const { insertAfter } = require('../idml/xml.ts') as typeof import('../idml/xml.ts');
        insertAfter(doc.root, ref, refs.at(-1));
        ctx.save(doc);
        return ok(`Created master page ${prefix}-${name} [${id}].`, { id, name: `${prefix}-${name}` });
      }),
  );

  reg.tool(
    'add_guides',
    {
      title: 'Add ruler guides',
      description:
        'Adds ruler guides to a page: explicit horizontal/vertical positions (from the page top-left), or guides along the margins and column edges.',
      inputSchema: toolInput({
        document: documentParam,
        page: pageParam.default(1),
        horizontal: z.array(lengthParam).optional().describe('Distances from the top of the page.'),
        vertical: z.array(lengthParam).optional().describe('Distances from the left edge of the page.'),
        fromMargins: z.boolean().optional().describe('Add guides on the four margins.'),
        fromColumns: z.boolean().optional().describe('Add guides on every column edge.'),
        color: z.string().optional().describe('Guide color name, e.g. Cyan, Magenta, Green.'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const page = findPage(doc, args.page);
        const spread = doc.findBySelf(page.spreadId)?.element;
        if (!spread) throw new Error('Spread not found');
        const { defaultLayerId } = require('../idml/layers.ts') as typeof import('../idml/layers.ts');
        const { fragment, insertAfter } = require('../idml/xml.ts') as typeof import('../idml/xml.ts');
        const layer = defaultLayerId(doc);
        const guides: { orientation: 'Horizontal' | 'Vertical'; location: number }[] = [];
        for (const h of args.horizontal ?? [])
          guides.push({ orientation: 'Horizontal', location: page.origin.y + ctx.pt(h) });
        for (const v of args.vertical ?? [])
          guides.push({ orientation: 'Vertical', location: page.origin.x + ctx.pt(v) });
        if (args.fromMargins) {
          guides.push({ orientation: 'Horizontal', location: page.origin.y + page.margins.top });
          guides.push({
            orientation: 'Horizontal',
            location: page.origin.y + page.height - page.margins.bottom,
          });
          guides.push({ orientation: 'Vertical', location: page.origin.x + page.margins.left });
          guides.push({ orientation: 'Vertical', location: page.origin.x + page.width - page.margins.right });
        }
        if (args.fromColumns && page.columns.count > 1) {
          const inner = page.width - page.margins.left - page.margins.right;
          const colW = (inner - page.columns.gutter * (page.columns.count - 1)) / page.columns.count;
          for (let i = 1; i < page.columns.count; i++) {
            const x = page.origin.x + page.margins.left + i * (colW + page.columns.gutter);
            guides.push({ orientation: 'Vertical', location: x - page.columns.gutter });
            guides.push({ orientation: 'Vertical', location: x });
          }
        }
        if (!guides.length) throw new Error('Give horizontal/vertical positions or fromMargins/fromColumns');
        let last = children(spread, 'Guide').at(-1) ?? children(spread, 'Page').at(-1);
        for (const g of guides) {
          const el = fragment(
            spread.ownerDocument!,
            `<Guide Self="${doc.newId()}" Orientation="${g.orientation}" Location="${formatNumber(g.location)}" FitToPage="true" ViewThreshold="5" Locked="false" ItemLayer="${layer}" PageIndex="${page.positionInSpread}" GuideType="Ruler" GuideZone="0" GuideColor="${args.color ?? 'Cyan'}"/>`,
          );
          insertAfter(spread, el, last);
          last = el;
        }
        ctx.save(doc);
        return ok(`Added ${guides.length} guide(s) to page ${page.index}.`, { count: guides.length });
      }),
  );

  reg.listing(
    'layers',
    {
      title: 'List layers',
      description: 'Lists layers (top-most first).',
      inputSchema: toolInput({ document: documentParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(() => {
        const layers = listLayers(ctx.open(document));
        return ok(
          layers
            .map((l) => `${l.name}${l.locked ? ' (locked)' : ''}${l.visible ? '' : ' (hidden)'} [${l.id}]`)
            .join('\n'),
          { layers },
        );
      }),
  );

  reg.variant(
    'edit_layers',
    'create',
    {
      title: 'Create layer',
      description: 'Creates a new layer on top of the others.',
      inputSchema: toolInput({
        document: documentParam,
        name: z.string(),
        color: z.string().optional().describe('Layer color name, e.g. Red, Green, LightBlue.'),
      }),
    },
    async ({ document, name, color }) =>
      run(() => {
        const doc = ctx.open(document);
        const layer = createLayer(doc, name, { color });
        ctx.save(doc);
        return ok(`Created layer "${layer.name}" [${layer.id}].`, { layer });
      }),
  );

  reg.variant(
    'edit_layers',
    'options',
    {
      title: 'Layer options',
      description: 'Renames, hides/shows or locks/unlocks a layer.',
      inputSchema: toolInput({
        document: documentParam,
        layer: z.string(),
        name: z.string().optional(),
        visible: z.boolean().optional(),
        locked: z.boolean().optional(),
      }),
    },
    async ({ document, layer, name, visible, locked }) =>
      run(() => {
        const doc = ctx.open(document);
        const el = findLayer(doc, layer);
        if (!el) throw new Error(`Layer "${layer}" not found`);
        setAttrs(el, { Name: name, Visible: visible, Locked: locked });
        ctx.save(doc);
        return ok('Layer updated.');
      }),
  );
}

/** Page ordering, layer management and master-item overrides. */
export function registerPageOpsTools(reg: ToolRegistry, ctx: ToolContext): void {
  reg.variant(
    'edit_pages',
    'move',
    {
      title: 'Move page',
      description:
        'Moves a page to another position. Spreads are rebuilt the way InDesign does it, and everything on the page moves with it.',
      inputSchema: toolInput({
        document: documentParam,
        page: pageParam,
        to: z.number().int().min(1).describe('New position (1 = first page).'),
      }),
    },
    async ({ document, page, to }) =>
      run(() => {
        const doc = ctx.open(document);
        const { movePage } = require('../idml/pageops.ts') as typeof import('../idml/pageops.ts');
        const pages = movePage(doc, page, to);
        ctx.save(doc);
        return ok(`Moved page to position ${to}. Order is now: ${pages.map((p) => p.name).join(', ')}.`, {
          pages: pages.map((p) => p.index),
        });
      }),
  );

  reg.variant(
    'edit_pages',
    'duplicate',
    {
      title: 'Duplicate page',
      description:
        'Copies a page with everything on it and inserts the copy after the original (or at a chosen position).',
      inputSchema: toolInput({
        document: documentParam,
        page: pageParam,
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Insert after this page number (0 = at the front).'),
      }),
    },
    async ({ document, page, after }) =>
      run(() => {
        const doc = ctx.open(document);
        const { duplicatePage } = require('../idml/pageops.ts') as typeof import('../idml/pageops.ts');
        const created = duplicatePage(doc, page, after);
        ctx.save(doc);
        return ok(`Duplicated page ${page} as page ${created.index}.`, { page: created.index });
      }),
  );

  reg.variant(
    'edit_pages',
    'reorder',
    {
      title: 'Reorder pages',
      description: 'Puts the pages in the given order, e.g. [3,1,2].',
      inputSchema: toolInput({
        document: documentParam,
        order: z.array(pageParam).min(1).describe('Every page, in the new order.'),
      }),
    },
    async ({ document, order }) =>
      run(() => {
        const doc = ctx.open(document);
        const { reflowPages } = require('../idml/pageops.ts') as typeof import('../idml/pageops.ts');
        const ids = order.map((p) => findPage(doc, p).id);
        const pages = reflowPages(doc, ids);
        ctx.save(doc);
        return ok(`Pages reordered: ${pages.map((p) => p.name).join(', ')}.`, {
          pages: pages.map((p) => p.index),
        });
      }),
  );

  reg.tool(
    'override_master_item',
    {
      title: 'Override master page item',
      description:
        'Makes an item that comes from the master page editable on one page (like Cmd/Ctrl+Shift-clicking it in InDesign). Use it to change a headline or logo on a single page.',
      inputSchema: toolInput({
        document: documentParam,
        page: pageParam,
        item: z.string().describe('Name or id of the item on the master page.'),
      }),
    },
    async ({ document, page, item }) =>
      run(() => {
        const doc = ctx.open(document);
        const { overrideMasterItem } = require('../idml/masters.ts') as typeof import('../idml/masters.ts');
        const el = overrideMasterItem(doc, page, item);
        ctx.save(doc);
        const id = el.getAttribute('Self')!;
        return ok(`"${item}" is now editable on page ${page} as [${id}].`, { id });
      }),
  );

  reg.variant(
    'edit_layers',
    'delete',
    {
      title: 'Delete layer',
      description: 'Deletes a layer; its items move to another layer, or are deleted with it.',
      inputSchema: toolInput({
        document: documentParam,
        layer: z.string(),
        moveItemsTo: z.string().optional(),
        deleteItems: z.boolean().optional(),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ document, layer, moveItemsTo, deleteItems }) =>
      run(() => {
        const doc = ctx.open(document);
        const { deleteLayer } = require('../idml/layers.ts') as typeof import('../idml/layers.ts');
        const r = deleteLayer(doc, layer, { moveItemsTo, deleteItems });
        ctx.save(doc);
        return ok(`Deleted layer "${layer}" (${r.moved} item(s) moved, ${r.deleted} deleted).`, r);
      }),
  );

  reg.variant(
    'edit_layers',
    'reorder',
    {
      title: 'Reorder layer',
      description: 'Moves a layer up or down the stack. Position 1 is the top-most layer.',
      inputSchema: toolInput({
        document: documentParam,
        layer: z.string(),
        position: z.number().int().min(1),
      }),
    },
    async ({ document, layer, position }) =>
      run(() => {
        const doc = ctx.open(document);
        const { reorderLayer } = require('../idml/layers.ts') as typeof import('../idml/layers.ts');
        const layers = reorderLayer(doc, layer, position);
        ctx.save(doc);
        return ok(`Layer order (top first): ${layers.map((l) => l.name).join(', ')}.`, { layers });
      }),
  );

  reg.variant(
    'edit_layers',
    'active',
    {
      title: 'Set active layer',
      description: 'Chooses the layer that new items are created on.',
      inputSchema: toolInput({ document: documentParam, layer: z.string() }),
    },
    async ({ document, layer }) =>
      run(() => {
        const doc = ctx.open(document);
        const { setActiveLayer } = require('../idml/layers.ts') as typeof import('../idml/layers.ts');
        setActiveLayer(doc, layer);
        ctx.save(doc);
        return ok(`New items will be created on layer "${layer}".`);
      }),
  );
}
