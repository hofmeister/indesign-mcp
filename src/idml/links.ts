// Linked graphics: listing their state, relinking to another file, embedding into the document
// and extracting embedded images back out to files.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { indesignFormatFor, probeImage } from '../images/files.ts';
import type { IdmlDocument } from './document.ts';
import { parseMatrix } from './geometry.ts';
import { FIT_NAMES, type FitMode, pathToLinkUri, refitImage } from './images.ts';
import { graphicChild, isPageItem, itemSpreadBounds, linkUriToPath } from './items.ts';
import { listPages, pageForSpreadRect } from './pages.ts';
import { attr, children, type Element, firstChild, numAttr, removeElement, setAttrs } from './xml.ts';

export type LinkStatus = 'ok' | 'missing' | 'modified' | 'embedded';

export interface LinkRecord {
  /** Self id of the frame holding the graphic. */
  frame: string;
  frameName: string | undefined;
  graphic: string;
  page: number | undefined;
  onMaster: string | undefined;
  path: string;
  fileName: string;
  format: string;
  status: LinkStatus;
  embedded: boolean;
  exists: boolean;
  widthPx: number;
  heightPx: number;
  actualPpi: number;
  effectivePpi: number;
  scalePercent: number;
  sizeBytes: number | undefined;
}

export interface GraphicHit {
  frame: Element;
  graphic: Element;
  link: Element | undefined;
  page: number | undefined;
  onMaster: string | undefined;
}

/** Every placed graphic in the document, including the ones inside groups and on masters. */
export function graphicHits(doc: IdmlDocument, options: { includeMasters?: boolean } = {}): GraphicHit[] {
  const pages = listPages(doc);
  const hits: GraphicHit[] = [];
  const scan = (container: Element, master?: string) => {
    const spreadId = attr(container, 'Self') ?? '';
    const visit = (el: Element) => {
      if (!isPageItem(el)) return;
      const g = graphicChild(el);
      if (g) {
        const bounds = itemSpreadBounds(el);
        const page = bounds ? pageForSpreadRect(pages, spreadId, bounds)?.index : undefined;
        hits.push({ frame: el, graphic: g, link: firstChild(g, 'Link'), page, onMaster: master });
      }
      if (el.tagName === 'Group') for (const c of children(el)) visit(c);
    };
    for (const el of children(container)) visit(el);
  };
  for (const spread of doc.spreads()) scan(spread);
  if (options.includeMasters !== false)
    for (const ms of doc.masterSpreads()) scan(ms, attr(ms, 'Name') ?? 'master');
  return hits;
}

function graphicPixelSize(graphic: Element): { width: number; height: number } {
  const gb = firstChild(firstChild(graphic, 'Properties'), 'GraphicBounds');
  if (!gb) return { width: 0, height: 0 };
  return {
    width: numAttr(gb, 'Right', 0) - numAttr(gb, 'Left', 0),
    height: numAttr(gb, 'Bottom', 0) - numAttr(gb, 'Top', 0),
  };
}

function contentsElement(graphic: Element): Element | undefined {
  return firstChild(firstChild(graphic, 'Properties'), 'Contents');
}

export function isEmbedded(graphic: Element): boolean {
  const link = firstChild(graphic, 'Link');
  return (link && attr(link, 'StoredState') === 'Embedded') || contentsElement(graphic) !== undefined;
}

/** True when the file on disk differs from the one that was placed (size or modification time). */
function fileChanged(link: Element, path: string): boolean {
  const stamp = attr(link, 'LinkImportStamp');
  if (!stamp || !existsSync(path)) return false;
  const m = /^file\s+(\d+)\s+(\d+)$/.exec(stamp);
  if (!m) return false;
  const st = statSync(path);
  return Number(m[2]) !== st.size || Math.abs(Math.floor(st.mtimeMs / 1000) - Number(m[1])) > 1;
}

export function linkRecord(hit: GraphicHit): LinkRecord {
  const uri = hit.link ? (attr(hit.link, 'LinkResourceURI') ?? '') : '';
  const path = uri ? linkUriToPath(uri) : '';
  const embedded = isEmbedded(hit.graphic);
  const exists = path ? existsSync(path) : false;
  const size = graphicPixelSize(hit.graphic);
  const m = parseMatrix(attr(hit.graphic, 'ItemTransform'));
  const actualPpi = Number((attr(hit.graphic, 'ActualPpi') ?? '72 72').split(/\s+/)[0]) || 72;
  const effective = hit.graphic.hasAttribute('EffectivePpi')
    ? Number(attr(hit.graphic, 'EffectivePpi')!.split(/\s+/)[0])
    : Math.round(actualPpi / (Math.abs(m[0]) || 1));
  return {
    frame: attr(hit.frame, 'Self') ?? '',
    frameName:
      attr(hit.frame, 'Name') && attr(hit.frame, 'Name') !== '$ID/' ? attr(hit.frame, 'Name') : undefined,
    graphic: attr(hit.graphic, 'Self') ?? '',
    page: hit.page,
    onMaster: hit.onMaster,
    path,
    fileName: path ? basename(path) : hit.graphic.tagName,
    format: (extname(path).slice(1) || hit.graphic.tagName).toLowerCase(),
    status: embedded
      ? 'embedded'
      : !exists
        ? 'missing'
        : hit.link && fileChanged(hit.link, path)
          ? 'modified'
          : 'ok',
    embedded,
    exists,
    widthPx: size.width,
    heightPx: size.height,
    actualPpi,
    effectivePpi: effective,
    scalePercent: Math.round(Math.abs(m[0]) * (actualPpi / 72) * 10000) / 100,
    sizeBytes: exists ? statSync(path).size : undefined,
  };
}

export function listLinks(doc: IdmlDocument): LinkRecord[] {
  return graphicHits(doc).map(linkRecord);
}

/** Finds a placed graphic by frame name/id, or by the linked file name. */
export function findGraphic(doc: IdmlDocument, ref: string): GraphicHit {
  const hits = graphicHits(doc);
  const needle = ref.toLowerCase();
  const matches = hits.filter((h) => {
    const rec = linkRecord(h);
    return (
      rec.frame === ref ||
      rec.graphic === ref ||
      (rec.frameName ?? '').toLowerCase() === needle ||
      rec.fileName.toLowerCase() === needle ||
      rec.path.toLowerCase() === needle
    );
  });
  if (!matches.length) throw new Error(`No placed image matches "${ref}". Use list_links to see them.`);
  if (matches.length > 1) {
    const where = matches
      .map((h) => {
        const r = linkRecord(h);
        return `${r.fileName} in ${r.frameName ?? r.frame}${r.page ? ` (page ${r.page})` : ''}`;
      })
      .join('; ');
    throw new Error(`"${ref}" matches ${matches.length} images: ${where}. Use the frame name or id.`);
  }
  return matches[0]!;
}

function currentFit(frame: Element): FitMode {
  const ffo = firstChild(frame, 'FrameFittingOption');
  const name = ffo ? attr(ffo, 'FittingOnEmptyFrame') : undefined;
  const found = (Object.keys(FIT_NAMES) as FitMode[]).find((k) => FIT_NAMES[k] === name);
  return found ?? 'fill';
}

export interface RelinkResult {
  from: string;
  to: string;
  widthPx: number;
  heightPx: number;
  effectivePpi: number;
}

/** Points a placed graphic at another file, keeping the frame and its fitting. */
export function relinkGraphic(
  _doc: IdmlDocument,
  hit: GraphicHit,
  newPath: string,
  options: { fit?: FitMode } = {},
): RelinkResult {
  const info = probeImage(newPath);
  const before = linkRecord(hit);
  const link = hit.link;
  if (!link) throw new Error('That graphic has no link to change (it may be embedded)');
  const st = statSync(info.path);
  setAttrs(link, {
    LinkResourceURI: pathToLinkUri(info.path),
    LinkResourceFormat: indesignFormatFor(info.path),
    StoredState: 'Normal',
    LinkResourceModified: 'false',
    LinkObjectModified: 'false',
    LinkImportStamp: `file ${Math.floor(st.mtimeMs / 1000)} ${st.size}`,
    LinkImportModificationTime: st.mtime.toISOString().replace(/\.\d+Z$/, ''),
    LinkImportTime: new Date().toISOString().replace(/\.\d+Z$/, ''),
    LinkResourceSize: `0~${st.size.toString(16)}`,
  });
  const gb = firstChild(firstChild(hit.graphic, 'Properties'), 'GraphicBounds');
  if (gb) setAttrs(gb, { Left: '0', Top: '0', Right: String(info.width), Bottom: String(info.height) });
  if (hit.graphic.hasAttribute('ActualPpi')) hit.graphic.setAttribute('ActualPpi', `${info.ppi} ${info.ppi}`);
  if (hit.graphic.hasAttribute('ImageTypeName'))
    hit.graphic.setAttribute('ImageTypeName', indesignFormatFor(info.path));
  const embedded = contentsElement(hit.graphic);
  if (embedded) removeElement(embedded);
  refitImage(hit.frame, options.fit ?? currentFit(hit.frame));
  const after = linkRecord({ ...hit, link });
  return {
    from: before.path,
    to: info.path,
    widthPx: info.width,
    heightPx: info.height,
    effectivePpi: after.effectivePpi,
  };
}

/** Copies the image bytes into the document so it no longer depends on the file on disk. */
export function embedGraphic(_doc: IdmlDocument, hit: GraphicHit): { fileName: string; bytes: number } {
  const rec = linkRecord(hit);
  if (rec.embedded) throw new Error(`${rec.fileName} is already embedded`);
  if (!rec.exists) throw new Error(`Cannot embed ${rec.fileName}: the file is missing (${rec.path})`);
  const bytes = readFileSync(rec.path);
  let props = firstChild(hit.graphic, 'Properties');
  if (!props) {
    props = hit.graphic.ownerDocument!.createElement('Properties');
    hit.graphic.insertBefore(props, hit.graphic.firstChild);
  }
  const existing = contentsElement(hit.graphic);
  if (existing) removeElement(existing);
  const contents = hit.graphic.ownerDocument!.createElement('Contents');
  contents.appendChild(hit.graphic.ownerDocument!.createCDATASection(bytes.toString('base64')));
  props.insertBefore(contents, props.firstChild);
  if (hit.link) setAttrs(hit.link, { StoredState: 'Embedded', CanEmbed: 'false', CanUnembed: 'true' });
  return { fileName: rec.fileName, bytes: bytes.length };
}

/** Writes an embedded image back to a file and links to it again. */
export function unembedGraphic(
  doc: IdmlDocument,
  hit: GraphicHit,
  dir: string,
  name?: string,
): { path: string; bytes: number } {
  const contents = contentsElement(hit.graphic);
  if (!contents) throw new Error('That image is not embedded');
  const base64 = (contents.textContent ?? '').replace(/\s+/g, '');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) throw new Error('The embedded image data is empty');
  const rec = linkRecord(hit);
  mkdirSync(dir, { recursive: true });
  const fallbackExt = rec.format && rec.format.length <= 4 ? rec.format : 'png';
  const fileName = name ?? (rec.path ? basename(rec.path) : `${rec.frameName ?? rec.frame}.${fallbackExt}`);
  const out = join(dir, fileName);
  writeFileSync(out, bytes);
  removeElement(contents);
  relinkGraphic(doc, hit, out);
  return { path: out, bytes: bytes.length };
}

/** Rewrites a graphic's link to a new location (used when packaging a document). */
export function repointLink(link: Element, newPath: string): void {
  setAttrs(link, { LinkResourceURI: pathToLinkUri(newPath) });
}
