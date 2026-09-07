import type { IdmlDocument } from './document.ts';
import { attr, children, type Element, fragment, insertAfter } from './xml.ts';

export interface LayerInfo {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  printable: boolean;
  color: string | undefined;
}

export const LAYER_COLORS = [
  'LightBlue',
  'Red',
  'Green',
  'Blue',
  'Yellow',
  'Magenta',
  'Cyan',
  'Gray',
  'Black',
  'Orange',
  'DarkGreen',
  'Teal',
  'Tan',
  'Brown',
  'Violet',
  'Gold',
  'DarkBlue',
  'Pink',
  'Lavender',
  'BrickRed',
  'Olive',
  'Peach',
  'BurgundyRed',
  'Grass',
  'Ochre',
  'Purple',
  'LightGray',
  'Charcoal',
  'GridBlue',
  'GridOrange',
  'Fiesta',
  'LightOlive',
  'Lipstick',
  'CuteTeal',
  'SulphurYellow',
  'GridGreen',
  'White',
] as const;

export function layerElements(doc: IdmlDocument): Element[] {
  return children(doc.root, 'Layer');
}

export function layerInfo(el: Element): LayerInfo {
  const colorEl = children(children(el, 'Properties')[0], 'LayerColor')[0];
  return {
    id: attr(el, 'Self') ?? '',
    name: attr(el, 'Name') ?? '',
    visible: attr(el, 'Visible') !== 'false',
    locked: attr(el, 'Locked') === 'true',
    printable: attr(el, 'Printable') !== 'false',
    color: colorEl?.textContent ?? undefined,
  };
}

/** Layers of the document, top-most first — the order InDesign's Layers panel shows. */
export function listLayers(doc: IdmlDocument): LayerInfo[] {
  return layerElements(doc).map(layerInfo).reverse();
}

/** Finds a layer by id or (case-insensitive) name. */
export function findLayer(doc: IdmlDocument, idOrName: string): Element | undefined {
  const layers = layerElements(doc);
  return (
    layers.find((l) => attr(l, 'Self') === idOrName) ??
    layers.find((l) => (attr(l, 'Name') ?? '').toLowerCase() === idOrName.toLowerCase())
  );
}

/**
 * The layer new items go on: the document's ActiveLayer if it exists and is unlocked,
 * otherwise the first unlocked layer, otherwise the first layer.
 */
export function defaultLayerId(doc: IdmlDocument): string {
  const layers = layerElements(doc);
  if (!layers.length) {
    return createLayer(doc, 'Layer 1').id;
  }
  const active = attr(doc.root, 'ActiveLayer');
  const activeEl = layers.find((l) => attr(l, 'Self') === active);
  if (activeEl && attr(activeEl, 'Locked') !== 'true') return active!;
  const unlocked = layers.find((l) => attr(l, 'Locked') !== 'true') ?? layers[0]!;
  return attr(unlocked, 'Self')!;
}

export function createLayer(
  doc: IdmlDocument,
  name: string,
  options: { color?: string; above?: string; visible?: boolean; locked?: boolean } = {},
): LayerInfo {
  if (findLayer(doc, name)) throw new Error(`A layer named "${name}" already exists`);
  const id = doc.newId();
  const existing = layerElements(doc);
  const color = options.color ?? LAYER_COLORS[existing.length % LAYER_COLORS.length]!;
  const el = fragment(
    doc.designmap,
    `<Layer Self="${id}" Name="${escapeAttr(name)}" Visible="${options.visible === false ? 'false' : 'true'}" Locked="${options.locked ? 'true' : 'false'}" IgnoreWrap="false" ShowGuides="true" LockGuides="false" UI="true" Expendable="true" Printable="true"><Properties><LayerColor type="enumeration">${color}</LayerColor></Properties></Layer>`,
  );
  // Designmap lists layers bottom-most first — InDesign's layer panel shows the last one on top —
  // so a new layer is appended after the others, as clicking "New Layer" does.
  const ref = options.above ? findLayer(doc, options.above) : undefined;
  if (ref) {
    insertAfter(doc.root, el, ref);
  } else if (existing.length) {
    insertAfter(doc.root, el, existing.at(-1)!);
  } else {
    insertAfter(
      doc.root,
      el,
      children(doc.root).find((c) => c.tagName.startsWith('idPkg:')),
    );
  }
  return layerInfo(el);
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * Deletes a layer. Items on it move to `moveItemsTo` (default: the first remaining layer),
 * or are deleted when `deleteItems` is true.
 */
export function deleteLayer(
  doc: import('./document.ts').IdmlDocument,
  ref: string,
  options: { moveItemsTo?: string; deleteItems?: boolean } = {},
): { moved: number; deleted: number } {
  const layers = layerElements(doc);
  if (layers.length <= 1) throw new Error('A document must keep at least one layer');
  const el = findLayer(doc, ref);
  if (!el) throw new Error(`Layer "${ref}" not found`);
  const id = attr(el, 'Self')!;
  const target = options.moveItemsTo
    ? findLayer(doc, options.moveItemsTo)
    : layers.find((l) => attr(l, 'Self') !== id);
  if (!options.deleteItems && !target) throw new Error(`Layer "${options.moveItemsTo}" not found`);
  const targetId = target ? attr(target, 'Self')! : undefined;
  let moved = 0;
  let deleted = 0;
  const { removeItemElement } = require('./pages.ts') as typeof import('./pages.ts');
  for (const part of [...doc.spreadParts(), ...doc.masterSpreadParts()]) {
    const root = doc.xml(part).documentElement;
    if (!root) continue;
    for (const item of Array.from(root.getElementsByTagName('*')) as Element[]) {
      if (attr(item, 'ItemLayer') !== id) continue;
      if (options.deleteItems) {
        removeItemElement(doc, item);
        deleted++;
      } else if (targetId) {
        item.setAttribute('ItemLayer', targetId);
        moved++;
      }
    }
  }
  el.parentNode?.removeChild(el);
  if (attr(doc.root, 'ActiveLayer') === id) {
    doc.root.setAttribute('ActiveLayer', attr(layers.find((l) => attr(l, 'Self') !== id)!, 'Self')!);
  }
  return { moved, deleted };
}

/**
 * Moves a layer in the stacking order. Position 1 is the top-most layer, as in InDesign's panel —
 * designmap stores them the other way round, bottom-most first.
 */
export function reorderLayer(
  doc: import('./document.ts').IdmlDocument,
  ref: string,
  position: number,
): LayerInfo[] {
  const layers = layerElements(doc);
  const el = findLayer(doc, ref);
  if (!el) throw new Error(`Layer "${ref}" not found`);
  const others = layers.filter((l) => l !== el);
  const fromTop = Math.max(0, Math.min(others.length, Math.floor(position) - 1));
  const index = others.length - fromTop; // how many layers stay below it
  el.parentNode?.removeChild(el);
  const before = others[index];
  if (before) doc.root.insertBefore(el, before);
  else if (others.length) insertAfter(doc.root, el, others.at(-1)!);
  else doc.root.appendChild(el);
  return listLayers(doc);
}

/** Sets the layer new items go on. */
export function setActiveLayer(doc: import('./document.ts').IdmlDocument, ref: string): string {
  const el = findLayer(doc, ref);
  if (!el) throw new Error(`Layer "${ref}" not found`);
  const id = attr(el, 'Self')!;
  doc.root.setAttribute('ActiveLayer', id);
  return id;
}
