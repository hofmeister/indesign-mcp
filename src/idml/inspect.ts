// Human-friendly and structured summaries of a document.
import type { IdmlDocument } from './document.ts';
import { type ItemInfo, listItems } from './items.ts';
import { type LayerInfo, listLayers } from './layers.ts';
import { appliedMasterOf, documentPageSize, isFacingPages, listPages, type PageInfo } from './pages.ts';
import { fontsUsed, listFonts, listStyles, listSwatches, type StyleInfo, type SwatchInfo } from './styles.ts';
import { formatLength, type Unit } from './units.ts';
import { attr, children, type Element, numAttr } from './xml.ts';

export interface MasterInfo {
  id: string;
  name: string;
  prefix: string;
  pageCount: number;
  itemCount: number;
  /** The master this one is based on, if any. */
  basedOn?: string;
  /** Document pages this master is applied to. */
  usedByPages: number[];
}

export interface DocumentSummary {
  path: string | undefined;
  domVersion: string;
  pageSize: { width: string; height: string };
  facingPages: boolean;
  bleed: string | undefined;
  pageCount: number;
  pages: PageSummary[];
  masters: MasterInfo[];
  layers: LayerInfo[];
  paragraphStyles: string[];
  characterStyles: string[];
  swatches: { name: string; hex: string | undefined; values: string }[];
  fonts: string[];
  fontsMissingFromDocument: string[];
  warnings: string[];
}

export interface PageSummary {
  number: number;
  name: string;
  side: string;
  master: string | undefined;
  margins: string;
  columns: number;
  items: ItemSummary[];
}

export interface ItemSummary {
  id: string;
  type: string;
  name: string | undefined;
  position: string;
  size: string;
  rotation?: number;
  layer?: string;
  fill?: string;
  stroke?: string;
  text?: string;
  /** Tables in the frame's story, when it holds any. */
  tables?: number;
  image?: string;
  overset?: boolean;
  children?: ItemSummary[];
}

export function itemSummary(item: ItemInfo, unit: Unit, layers: Map<string, string>): ItemSummary {
  const b = item.bounds;
  const s: ItemSummary = {
    id: item.id,
    type: item.type,
    name: item.name,
    position: b ? `${formatLength(b.x, unit)}, ${formatLength(b.y, unit)}` : 'unknown',
    size: b ? `${formatLength(b.width, unit)} × ${formatLength(b.height, unit)}` : 'unknown',
  };
  if (item.rotation) s.rotation = item.rotation;
  if (item.layer) s.layer = layers.get(item.layer) ?? item.layer;
  if (item.fill && item.fill !== 'none') s.fill = item.fill;
  if (item.stroke && item.stroke !== 'none' && item.strokeWeight > 0)
    s.stroke = `${item.stroke} ${item.strokeWeight}pt`;
  if (item.text !== undefined) s.text = item.text.length > 160 ? `${item.text.slice(0, 157)}…` : item.text;
  if (item.tables) s.tables = item.tables;
  if (item.imagePath) s.image = item.imagePath;
  if (item.children) s.children = item.children.map((c) => itemSummary(c, unit, layers));
  return s;
}

export function masterInfos(doc: IdmlDocument): MasterInfo[] {
  const names = new Map(doc.masterSpreads().map((m) => [attr(m, 'Self') ?? '', attr(m, 'Name') ?? '']));
  // Which document pages use each master: with several masters in a document, that is the thing
  // you actually want to know about them.
  const usedBy = new Map<string, number[]>();
  for (const page of listPages(doc)) {
    if (!page.appliedMaster) continue;
    const list = usedBy.get(page.appliedMaster) ?? [];
    list.push(page.index);
    usedBy.set(page.appliedMaster, list);
  }
  return doc.masterSpreads().map((m) => {
    const id = attr(m, 'Self') ?? '';
    const parent = appliedMasterOf(children(m, 'Page')[0]);
    return {
      id,
      name: attr(m, 'Name') ?? '',
      prefix: attr(m, 'NamePrefix') ?? '',
      pageCount: children(m, 'Page').length,
      itemCount: children(m).filter((c) => !['Page', 'Properties', 'FlattenerPreference'].includes(c.tagName))
        .length,
      basedOn: parent ? (names.get(parent) ?? parent) : undefined,
      usedByPages: usedBy.get(id) ?? [],
    };
  });
}

export function summarizeDocument(doc: IdmlDocument, unit: Unit = 'mm'): DocumentSummary {
  const pages = listPages(doc);
  const items = listItems(doc);
  const layers = listLayers(doc);
  const layerNames = new Map(layers.map((l) => [l.id, l.name]));
  const masters = masterInfos(doc);
  const masterNames = new Map(masters.map((m) => [m.id, m.name]));
  const size = documentPageSize(doc);
  const dp = children(doc.resource('Preferences'), 'DocumentPreference')[0];
  const bleed = dp ? numAttr(dp, 'DocumentBleedTopOffset', 0) : 0;
  const fontList = listFonts(doc);
  const used = fontsUsed(doc);
  const known = new Set(fontList.map((f) => f.family));
  const warnings: string[] = [];
  const missingImages = items.filter((i) => i.imagePath && !fileExists(i.imagePath)).map((i) => i.imagePath!);
  if (missingImages.length)
    warnings.push(
      `${missingImages.length} linked image(s) not found on disk: ${missingImages.slice(0, 3).join(', ')}${missingImages.length > 3 ? '…' : ''}`,
    );

  return {
    path: doc.path,
    domVersion: doc.domVersion,
    pageSize: { width: formatLength(size.width, unit), height: formatLength(size.height, unit) },
    facingPages: isFacingPages(doc),
    bleed: bleed ? formatLength(bleed, unit) : undefined,
    pageCount: pages.length,
    pages: pages.map((p) => pageSummary(p, items, unit, layerNames, masterNames)),
    masters,
    layers,
    paragraphStyles: listStyles(doc, 'ParagraphStyle').map(styleLabel),
    characterStyles: listStyles(doc, 'CharacterStyle').map(styleLabel),
    swatches: listSwatches(doc)
      .filter((s) => s.kind !== 'none')
      .map((s: SwatchInfo) => ({
        name: s.name,
        hex: s.hex,
        values: s.space ? `${s.space} ${s.values.join(' ')}` : s.kind,
      })),
    fonts: fontList.map((f) => `${f.family} (${f.styles.join(', ')})`),
    fontsMissingFromDocument: [...used].filter((f) => !known.has(f)),
    warnings,
  };
}

function styleLabel(s: StyleInfo): string {
  const parts = [s.group ? `${s.group}/${s.name}` : s.name];
  const details = [s.font, s.fontStyle, s.pointSize ? `${s.pointSize}pt` : undefined]
    .filter(Boolean)
    .join(' ');
  if (details) parts.push(`(${details})`);
  return parts.join(' ');
}

function pageSummary(
  p: PageInfo,
  items: ItemInfo[],
  unit: Unit,
  layers: Map<string, string>,
  masters: Map<string, string>,
): PageSummary {
  return {
    number: p.index,
    name: p.name,
    side: p.side,
    master: p.appliedMaster ? (masters.get(p.appliedMaster) ?? p.appliedMaster) : undefined,
    margins: `top ${formatLength(p.margins.top, unit)}, bottom ${formatLength(p.margins.bottom, unit)}, left ${formatLength(p.margins.left, unit)}, right ${formatLength(p.margins.right, unit)}`,
    columns: p.columns.count,
    items: items.filter((i) => i.page === p.index).map((i) => itemSummary(i, unit, layers)),
  };
}

function fileExists(path: string): boolean {
  try {
    return require('node:fs').existsSync(path);
  } catch {
    return false;
  }
}

/** Compact markdown rendering of the summary, for the tool's text content. */
export function summaryToMarkdown(s: DocumentSummary): string {
  const lines: string[] = [];
  lines.push(`# ${s.path ?? 'Document'}`);
  lines.push(
    `${s.pageCount} page${s.pageCount === 1 ? '' : 's'}, ${s.pageSize.width} × ${s.pageSize.height}${s.facingPages ? ', facing pages' : ''}${s.bleed ? `, bleed ${s.bleed}` : ''} (IDML ${s.domVersion})`,
  );
  if (s.masters.length)
    lines.push(`Master pages: ${s.masters.map((m) => `${m.name} (${m.itemCount} items)`).join(', ')}`);
  lines.push(
    `Layers: ${s.layers.map((l) => l.name + (l.locked ? ' (locked)' : '') + (l.visible ? '' : ' (hidden)')).join(', ')}`,
  );
  lines.push('');
  for (const p of s.pages) {
    lines.push(
      `## Page ${p.number}${p.name !== String(p.number) ? ` ("${p.name}")` : ''}${p.side !== 'single' ? ` — ${p.side}` : ''}${p.master ? `, master ${p.master}` : ''}`,
    );
    lines.push(`Margins: ${p.margins}; columns: ${p.columns}`);
    if (!p.items.length) lines.push('_(empty)_');
    for (const it of p.items) lines.push(itemLine(it, ''));
    lines.push('');
  }
  lines.push(`## Paragraph styles\n${s.paragraphStyles.join('; ') || 'none'}`);
  lines.push(`## Character styles\n${s.characterStyles.join('; ') || 'none'}`);
  lines.push(
    `## Swatches\n${s.swatches.map((sw) => `${sw.name}${sw.hex ? ` ${sw.hex}` : ''}`).join('; ') || 'none'}`,
  );
  lines.push(`## Fonts\n${s.fonts.join('; ') || 'none'}`);
  if (s.fontsMissingFromDocument.length)
    lines.push(`Fonts used but not listed in the document: ${s.fontsMissingFromDocument.join(', ')}`);
  if (s.warnings.length) lines.push(`\n## Warnings\n${s.warnings.map((w) => `- ${w}`).join('\n')}`);
  return lines.join('\n');
}

function itemLine(it: ItemSummary, indent: string): string {
  const bits = [
    `${indent}- ${it.type}${it.name ? ` "${it.name}"` : ''} [${it.id}] at ${it.position}, ${it.size}`,
  ];
  if (it.rotation) bits.push(`rotated ${it.rotation}°`);
  if (it.fill) bits.push(`fill ${it.fill}`);
  if (it.stroke) bits.push(`stroke ${it.stroke}`);
  if (it.layer) bits.push(`layer ${it.layer}`);
  if (it.image) bits.push(`image ${it.image}`);
  let line = bits.join(', ');
  if (it.text !== undefined) line += `: "${it.text.replace(/\n/g, ' ¶ ')}"`;
  if (it.children) line += `\n${it.children.map((c) => itemLine(c, `${indent}  `)).join('\n')}`;
  return line;
}

export type { Element };
