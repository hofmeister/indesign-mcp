// Placing raster/vector images into graphic frames.
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { type ImageFileInfo, indesignFormatFor, probeImage } from '../images/files.ts';
import type { IdmlDocument } from './document.ts';
import {
  anchorBounds,
  formatMatrix,
  IDENTITY,
  multiply,
  parseMatrix,
  type Rect,
  readPaths,
} from './geometry.ts';
import { createRectangle, graphicChild, type NewItemOptions, type Target } from './items.ts';
import {
  attr,
  children,
  type Element,
  firstChild,
  fragment,
  insertAfter,
  removeElement,
  setAttrs,
} from './xml.ts';

export type FitMode = 'fill' | 'fit' | 'stretch' | 'center' | 'frame-to-content';

export const FIT_NAMES: Record<FitMode, string> = {
  fill: 'FillProportionally',
  fit: 'Proportionally',
  stretch: 'ContentToFrame',
  center: 'CenterContent',
  'frame-to-content': 'FrameToContent',
};

/** file:/... URI the way InDesign writes it (single slash after "file:"). */
export function pathToLinkUri(path: string): string {
  const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(path);
  const abs = (isWindowsAbs ? path : resolve(path)).replace(/\\/g, '/');
  const encoded = abs
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/g, ':'))
    .join('/');
  return abs.startsWith('/') ? `file:${encoded}` : `file:/${encoded}`;
}

function frameLocalBounds(frame: Element): Rect {
  const paths = readPaths(frame);
  return anchorBounds(paths);
}

/** Transform for the image inside the frame, in the frame's local coordinate space. */
export function imageTransformFor(
  frame: Rect,
  image: { width: number; height: number; ppi: number },
  fit: FitMode,
): { matrix: [number, number, number, number, number, number]; scaleX: number; scaleY: number } {
  const natural = { w: (image.width * 72) / image.ppi, h: (image.height * 72) / image.ppi };
  // The image's own coordinate space is pixels at 72 ppi, i.e. 1 unit = 1 pt at 100 %.
  const pxScale = 72 / image.ppi;
  let sx: number;
  let sy: number;
  switch (fit) {
    case 'fill':
      sx = sy = Math.max(frame.width / natural.w, frame.height / natural.h) * pxScale;
      break;
    case 'fit':
      sx = sy = Math.min(frame.width / natural.w, frame.height / natural.h) * pxScale;
      break;
    case 'stretch':
      sx = (frame.width / natural.w) * pxScale;
      sy = (frame.height / natural.h) * pxScale;
      break;
    default:
      sx = sy = pxScale;
  }
  const w = image.width * sx;
  const h = image.height * sy;
  const tx = frame.x + (frame.width - w) / 2;
  const ty = frame.y + (frame.height - h) / 2;
  return { matrix: [sx, 0, 0, sy, tx, ty], scaleX: sx, scaleY: sy };
}

export interface PlaceOptions {
  /** Absolute path of the image file. */
  path: string;
  fit?: FitMode;
}

function linkXml(doc: IdmlDocument, info: ImageFileInfo): string {
  const st = statSync(info.path);
  const iso = st.mtime.toISOString().replace(/\.\d+Z$/, '');
  const now = new Date().toISOString().replace(/\.\d+Z$/, '');
  return `<Link Self="${doc.newId()}" AssetURL="$ID/" AssetID="$ID/" LinkResourceURI="${pathToLinkUri(info.path)}" LinkResourceFormat="${indesignFormatFor(info.path)}" StoredState="Normal" LinkClassID="35906" LinkClientID="257" LinkResourceModified="false" LinkObjectModified="false" ShowInUI="true" CanEmbed="true" CanUnembed="true" CanPackage="true" ImportPolicy="NoAutoImport" ExportPolicy="NoAutoExport" LinkImportStamp="file ${Math.floor(st.mtimeMs / 1000)} ${st.size}" LinkImportModificationTime="${iso}" LinkImportTime="${now}" LinkResourceSize="0~${st.size.toString(16)}"/>`;
}

/** Puts an image into an existing frame (replacing any existing graphic). */
export function fillFrameWithImage(doc: IdmlDocument, frame: Element, options: PlaceOptions): ImageFileInfo {
  const info = probeImage(options.path);
  const fit = options.fit ?? 'fill';
  const existing = graphicChild(frame);
  if (existing) removeElement(existing);
  const local = frameLocalBounds(frame);
  const { matrix, scaleX } = imageTransformFor(local, info, fit === 'frame-to-content' ? 'center' : fit);
  const isVector = ['pdf', 'ai', 'eps'].includes(info.format);
  const tag = isVector ? (info.format === 'eps' ? 'EPS' : 'PDF') : 'Image';
  const effectivePpi = Math.round(72 / scaleX);
  const image = fragment(
    frame.ownerDocument!,
    `<${tag} Self="${doc.newId()}"${isVector ? '' : ` Space="$ID/#Links_RGB" ActualPpi="${info.ppi} ${info.ppi}" EffectivePpi="${effectivePpi} ${effectivePpi}" ImageRenderingIntent="UseColorSettings" ImageTypeName="${indesignFormatFor(info.path)}"`} OverriddenPageItemProps="" LocalDisplaySetting="Default" AppliedObjectStyle="ObjectStyle/$ID/[None]" ItemTransform="${formatMatrix(matrix)}" Visible="true" Name="$ID/"><Properties>${isVector ? '' : '<Profile type="string">$ID/Embedded</Profile>'}<GraphicBounds Left="0" Top="0" Right="${info.width}" Bottom="${info.height}"/></Properties>${linkXml(doc, info)}</${tag}>`,
  );
  frame.appendChild(image);
  setAttrs(frame, { ContentType: 'GraphicType' });
  if ((attr(frame, 'AppliedObjectStyle') ?? '').endsWith('[None]'))
    frame.setAttribute('AppliedObjectStyle', 'ObjectStyle/$ID/[Normal Graphics Frame]');
  let ffo = firstChild(frame, 'FrameFittingOption');
  if (!ffo) {
    ffo = fragment(
      frame.ownerDocument!,
      `<FrameFittingOption AutoFit="false" LeftCrop="0" TopCrop="0" RightCrop="0" BottomCrop="0" FittingOnEmptyFrame="FillProportionally" FittingAlignment="CenterAnchor"/>`,
    );
    insertAfter(frame, ffo, firstChild(frame, 'TextWrapPreference') ?? firstChild(frame, 'Properties'));
  }
  ffo.setAttribute('FittingOnEmptyFrame', FIT_NAMES[fit]);
  if (fit === 'frame-to-content') {
    // resize frame to the image's natural size (at 100 %), keeping the top-left corner
    const { writePaths, rectPath } = require('./geometry.ts') as typeof import('./geometry.ts');
    const natural = { width: (info.width * 72) / info.ppi, height: (info.height * 72) / info.ppi };
    writePaths(frame, [rectPath({ x: local.x, y: local.y, width: natural.width, height: natural.height })]);
    image.setAttribute('ItemTransform', formatMatrix([72 / info.ppi, 0, 0, 72 / info.ppi, local.x, local.y]));
  }
  return info;
}

/** Creates a graphic frame on a page/master and places the image in it. */
export function placeImage(
  doc: IdmlDocument,
  target: Target,
  frameOptions: NewItemOptions,
  options: PlaceOptions,
): { frame: Element; info: ImageFileInfo } {
  const frame = createRectangle(doc, target, {
    ...frameOptions,
    fill: frameOptions.fill ?? 'none',
    graphicFrame: true,
  });
  const info = fillFrameWithImage(doc, frame, options);
  if (!frameOptions.name) frame.setAttribute('Name', basename(options.path));
  return { frame, info };
}

/** Re-applies a fit mode to the graphic already in the frame. */
export function refitImage(frame: Element, fit: FitMode): void {
  const image = graphicChild(frame);
  if (!image) throw new Error('The frame has no image');
  const gb = firstChild(children(image, 'Properties')[0], 'GraphicBounds');
  const width = Number(attr(gb!, 'Right') ?? 0) - Number(attr(gb!, 'Left') ?? 0);
  const height = Number(attr(gb!, 'Bottom') ?? 0) - Number(attr(gb!, 'Top') ?? 0);
  const ppi = Number((attr(image, 'ActualPpi') ?? '72 72').split(/\s+/)[0]) || 72;
  const local = frameLocalBounds(frame);
  if (fit === 'frame-to-content') {
    const { writePaths, rectPath } = require('./geometry.ts') as typeof import('./geometry.ts');
    const m = parseMatrix(attr(image, 'ItemTransform'));
    const w = width * m[0];
    const h = height * m[3];
    writePaths(frame, [rectPath({ x: m[4], y: m[5], width: w, height: h })]);
  } else {
    const { matrix, scaleX } = imageTransformFor(local, { width, height, ppi }, fit);
    image.setAttribute('ItemTransform', formatMatrix(matrix));
    const eff = Math.round(72 / scaleX);
    if (image.hasAttribute('EffectivePpi')) image.setAttribute('EffectivePpi', `${eff} ${eff}`);
  }
  const ffo = firstChild(frame, 'FrameFittingOption');
  if (ffo) ffo.setAttribute('FittingOnEmptyFrame', FIT_NAMES[fit]);
}

export interface PlacedImageInfo {
  path: string;
  widthPx: number;
  heightPx: number;
  effectivePpi: number | undefined;
  scalePercent: number;
}

export function placedImageInfo(frame: Element): PlacedImageInfo | undefined {
  const image = graphicChild(frame);
  if (!image) return undefined;
  const link = firstChild(image, 'Link');
  const gb = firstChild(children(image, 'Properties')[0], 'GraphicBounds');
  const m = parseMatrix(attr(image, 'ItemTransform'));
  const ppi = Number((attr(image, 'ActualPpi') ?? '72 72').split(/\s+/)[0]) || 72;
  return {
    path: link
      ? (require('./items.ts') as typeof import('./items.ts')).linkUriToPath(
          attr(link, 'LinkResourceURI') ?? '',
        )
      : '',
    widthPx: gb ? Number(attr(gb, 'Right') ?? 0) - Number(attr(gb, 'Left') ?? 0) : 0,
    heightPx: gb ? Number(attr(gb, 'Bottom') ?? 0) - Number(attr(gb, 'Top') ?? 0) : 0,
    effectivePpi: image.hasAttribute('EffectivePpi')
      ? Number(attr(image, 'EffectivePpi')!.split(/\s+/)[0])
      : undefined,
    scalePercent: Math.round(((m[0] * ppi) / 72) * 10000) / 100,
  };
}

export { IDENTITY, multiply };
