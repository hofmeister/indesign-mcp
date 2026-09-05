import type { McpServer } from '@modelcontextprotocol/server';
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
import { attr, children, formatNumber, setAttrs } from '../idml/xml.ts';
import type { ToolContext } from './context.ts';
import { documentParam, lengthParam, ok, pageParam, run } from './shared.ts';

export function registerPageTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'Lists the pages with size, side (left/right), margins, columns and applied master page.',
      inputSchema: z.object({ document: documentParam }),
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

  server.registerTool(
    'add_pages',
    {
      title: 'Add pages',
      description:
        'Adds pages at the end of the document (new pages get the same master as the last page unless specified).',
      inputSchema: z.object({
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

  server.registerTool(
    'remove_pages',
    {
      title: 'Remove pages',
      description: 'Deletes pages and everything on them.',
      inputSchema: z.object({ document: documentParam, pages: z.array(pageParam).min(1) }),
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

  server.registerTool(
    'set_page_size',
    {
      title: 'Set page size',
      description: `Changes the page size of the whole document. Presets: ${Object.keys(PAGE_SIZES).join(', ')}, or give width and height. Existing items keep their position relative to the top-left corner of their page.`,
      inputSchema: z.object({
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

  server.registerTool(
    'set_margins_and_columns',
    {
      title: 'Margins and columns',
      description: 'Sets page margins and column guides for all pages, or for specific pages.',
      inputSchema: z.object({
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

  server.registerTool(
    'list_masters',
    {
      title: 'List master pages',
      description: 'Lists master pages (parent pages) with the number of items on each.',
      inputSchema: z.object({ document: documentParam }),
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

  server.registerTool(
    'apply_master',
    {
      title: 'Apply master page',
      description: 'Applies a master page (or "none") to the given pages.',
      inputSchema: z.object({
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

  server.registerTool(
    'create_master',
    {
      title: 'Create master page',
      description:
        'Creates a new master page (parent page) by duplicating an existing one, e.g. "B-Chapter" based on "A-Master". Add items to it with add_text_frame etc. using target master.',
      inputSchema: z.object({
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
        const ref = doc.designmap.createElement('idPkg:MasterSpread');
        ref.setAttribute('src', part);
        const refs = children(doc.root).filter((c) => c.tagName === 'idPkg:MasterSpread');
        const { insertAfter } = require('../idml/xml.ts') as typeof import('../idml/xml.ts');
        insertAfter(doc.root, ref, refs.at(-1));
        ctx.save(doc);
        return ok(`Created master page ${prefix}-${name} [${id}].`, { id, name: `${prefix}-${name}` });
      }),
  );

  server.registerTool(
    'list_layers',
    {
      title: 'List layers',
      description: 'Lists layers (top-most first).',
      inputSchema: z.object({ document: documentParam }),
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

  server.registerTool(
    'create_layer',
    {
      title: 'Create layer',
      description: 'Creates a new layer on top of the others.',
      inputSchema: z.object({
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

  server.registerTool(
    'set_layer_options',
    {
      title: 'Layer options',
      description: 'Renames, hides/shows or locks/unlocks a layer.',
      inputSchema: z.object({
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
