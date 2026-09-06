// Creating documents from the bundled blank template (a stripped real InDesign export).
import { readFileSync } from 'node:fs';
import { IdmlDocument } from './document.ts';
import { formatMatrix } from './geometry.ts';
import { addPages, documentPreference, listPages, pageTransform, removePages } from './pages.ts';
import blankTemplatePath from './template/blank.idml' with { type: 'file' };
import { formatLength, type LengthInput, resolvePageSize, toPoints, type Unit } from './units.ts';
import { attr, children, type Element, firstChild, formatNumber, removeElement, setAttrs } from './xml.ts';

export interface NewDocumentOptions {
  pageSize?: string;
  orientation?: 'portrait' | 'landscape';
  width?: LengthInput;
  height?: LengthInput;
  pages?: number;
  facingPages?: boolean;
  margins?:
    | LengthInput
    | {
        top: LengthInput;
        bottom: LengthInput;
        inside?: LengthInput;
        outside?: LengthInput;
        left?: LengthInput;
        right?: LengthInput;
      };
  columns?: number;
  gutter?: LengthInput;
  bleed?: LengthInput;
  unit?: Unit;
  /** Bytes of a template IDML to clone instead of the bundled blank one. */
  templateBytes?: Uint8Array;
  /** When cloning a template: keep its pages and content (default false = clear pages to blank). */
  keepContent?: boolean;
}

export function loadBlankTemplateBytes(): Uint8Array {
  return new Uint8Array(readFileSync(blankTemplatePath));
}

export function createDocument(options: NewDocumentOptions = {}): IdmlDocument {
  const unit = options.unit ?? 'mm';
  const bytes = options.templateBytes ?? loadBlankTemplateBytes();
  const doc = IdmlDocument.fromBytes(bytes);

  const size =
    options.pageSize || options.width !== undefined
      ? resolvePageSize(options.pageSize, options.orientation, options.width, options.height, unit)
      : undefined;
  const dp = documentPreference(doc);
  if (size) setAttrs(dp, { PageWidth: size.width, PageHeight: size.height });
  // A new document is single-page unless facing pages are asked for; a cloned template keeps
  // whatever it had.
  const keepTemplateContent = options.templateBytes !== undefined && options.keepContent === true;
  if (options.facingPages !== undefined)
    dp.setAttribute('FacingPages', options.facingPages ? 'true' : 'false');
  else if (!keepTemplateContent) dp.setAttribute('FacingPages', 'false');
  if (options.bleed !== undefined) {
    const b = toPoints(options.bleed, unit);
    setAttrs(dp, {
      DocumentBleedTopOffset: b,
      DocumentBleedBottomOffset: b,
      DocumentBleedInsideOrLeftOffset: b,
      DocumentBleedOutsideOrRightOffset: b,
      DocumentBleedUniformSize: true,
    });
  }
  // measurement units shown in InDesign's rulers
  const view = firstChild(doc.resource('Preferences'), 'ViewPreference');
  if (view) {
    const u = { mm: 'Millimeters', cm: 'Centimeters', in: 'Inches', pt: 'Points', px: 'Pixels', p: 'Picas' }[
      unit
    ];
    setAttrs(view, { HorizontalMeasurementUnits: u, VerticalMeasurementUnits: u });
  }

  if (!keepTemplateContent) {
    // Reduce to exactly one page, then resize it, then add the requested number of pages.
    const pages = listPages(doc);
    if (pages.length > 1)
      removePages(
        doc,
        pages.slice(1).map((p) => p.index),
      );
    const facing = attr(dp, 'FacingPages') === 'true';
    const w = Number(attr(dp, 'PageWidth'));
    const h = Number(attr(dp, 'PageHeight'));
    for (const spread of doc.spreads()) {
      for (const page of children(spread, 'Page')) {
        setAttrs(page, {
          GeometricBounds: `0 0 ${formatNumber(h)} ${formatNumber(w)}`,
          ItemTransform: formatMatrix(pageTransform(w, h, facing, facing ? 'right' : 'single')),
        });
        // delete items on the page except the page itself (blank template should have none, but be safe)
      }
      for (const item of children(spread)) {
        if (!['Page', 'FlattenerPreference', 'Properties'].includes(item.tagName)) spread.removeChild(item);
      }
    }
    // Master spread pages get the same size, and the same number of pages per spread as the
    // document itself: a single-page document needs a single-page master, or its items would sit
    // on the wrong half of a facing master.
    for (const master of doc.masterSpreads()) {
      if (!facing) {
        for (const extra of children(master, 'Page').slice(1)) removeElement(extra);
        master.setAttribute('PageCount', '1');
      }
      // The bundled template comes from a localized InDesign, so give new documents the neutral
      // master name people expect.
      if (options.templateBytes === undefined) {
        const prefix = attr(master, 'NamePrefix') ?? 'A';
        setAttrs(master, { BaseName: 'Master', Name: `${prefix}-Master` });
      }
      const mpages = children(master, 'Page');
      mpages.forEach((page, i) => {
        const side = mpages.length === 1 ? (facing ? 'right' : 'single') : i === 0 ? 'left' : 'right';
        setAttrs(page, {
          GeometricBounds: `0 0 ${formatNumber(h)} ${formatNumber(w)}`,
          ItemTransform: formatMatrix(pageTransform(w, h, facing || mpages.length > 1, side)),
        });
      });
    }
    // The template's own section may start at another number; a new document starts at page 1.
    const section = children(doc.root, 'Section')[0];
    if (section) setAttrs(section, { PageNumberStart: 1, ContinueNumbering: 'false' });
    applyMargins(doc, options, unit);
    const wanted = Math.max(1, Math.floor(options.pages ?? 1));
    if (wanted > 1) addPages(doc, { count: wanted - 1 });
  }
  return doc;
}

export function applyMargins(
  doc: IdmlDocument,
  options: Pick<NewDocumentOptions, 'margins' | 'columns' | 'gutter'>,
  unit: Unit,
  pageRefs?: number[],
): void {
  if (options.margins === undefined && options.columns === undefined && options.gutter === undefined) return;
  let m: { top: number; bottom: number; left: number; right: number } | undefined;
  if (options.margins !== undefined) {
    if (typeof options.margins === 'object') {
      const o = options.margins;
      m = {
        top: toPoints(o.top, unit),
        bottom: toPoints(o.bottom, unit),
        left: toPoints(o.left ?? o.inside ?? o.top, unit),
        right: toPoints(o.right ?? o.outside ?? o.top, unit),
      };
    } else {
      const v = toPoints(options.margins, unit);
      m = { top: v, bottom: v, left: v, right: v };
    }
  }
  const targets = [...doc.spreads(), ...(pageRefs ? [] : doc.masterSpreads())];
  const pages = listPages(doc);
  const affected: Element[] = [];
  for (const spread of targets) {
    for (const page of children(spread, 'Page')) {
      if (pageRefs) {
        const info = pages.find((p) => p.id === attr(page, 'Self'));
        if (!info || !pageRefs.includes(info.index)) continue;
      }
      if (firstChild(page, 'MarginPreference')) affected.push(page);
    }
  }
  // Check every page before changing anything: margins that do not leave room for text would
  // give InDesign a column of negative width.
  for (const page of affected) {
    const pref = firstChild(page, 'MarginPreference')!;
    const bounds = (attr(page, 'GeometricBounds') ?? '0 0 0 0').split(/\s+/).map(Number);
    const pageWidth = (bounds[3] ?? 0) - (bounds[1] ?? 0);
    const pageHeight = (bounds[2] ?? 0) - (bounds[0] ?? 0);
    const margins = m ?? {
      top: Number(attr(pref, 'Top') ?? 0),
      bottom: Number(attr(pref, 'Bottom') ?? 0),
      left: Number(attr(pref, 'Left') ?? 0),
      right: Number(attr(pref, 'Right') ?? 0),
    };
    const inner = pageWidth - margins.left - margins.right;
    const innerHeight = pageHeight - margins.top - margins.bottom;
    const name = attr(page, 'Name') ?? '?';
    if (inner <= 0 || innerHeight <= 0) {
      throw new Error(
        `Those margins leave no room on page ${name}: the page is ${formatLength(pageWidth, unit)} × ${formatLength(pageHeight, unit)} and the margins take ${formatLength(margins.left + margins.right, unit)} across and ${formatLength(margins.top + margins.bottom, unit)} down.`,
      );
    }
    const count =
      options.columns !== undefined
        ? Math.max(1, Math.floor(options.columns))
        : Number(attr(pref, 'ColumnCount') ?? 1);
    const gutter =
      options.gutter !== undefined
        ? toPoints(options.gutter, unit)
        : Number(attr(pref, 'ColumnGutter') ?? 12);
    if (count > 1 && (inner - gutter * (count - 1)) / count <= 0) {
      throw new Error(
        `${count} columns with a ${formatLength(gutter, unit)} gutter do not fit in ${formatLength(inner, unit)} of text width on page ${name}. Use fewer columns or a smaller gutter.`,
      );
    }
  }
  for (const spread of targets) {
    for (const page of children(spread, 'Page')) {
      if (!affected.includes(page)) continue;
      const pref = firstChild(page, 'MarginPreference');
      if (!pref) continue;
      if (m) setAttrs(pref, { Top: m.top, Bottom: m.bottom, Left: m.left, Right: m.right });
      if (options.columns !== undefined)
        pref.setAttribute('ColumnCount', String(Math.max(1, Math.floor(options.columns))));
      if (options.gutter !== undefined)
        pref.setAttribute('ColumnGutter', formatNumber(toPoints(options.gutter, unit)));
      // ColumnsPositions: recompute for the page width
      const bounds = (attr(page, 'GeometricBounds') ?? '0 0 0 0').split(/\s+/).map(Number);
      const width = (bounds[3] ?? 0) - (bounds[1] ?? 0);
      const left = Number(attr(pref, 'Left') ?? 0);
      const right = Number(attr(pref, 'Right') ?? 0);
      const count = Number(attr(pref, 'ColumnCount') ?? 1);
      const gutter = Number(attr(pref, 'ColumnGutter') ?? 12);
      const inner = width - left - right;
      const colWidth = (inner - gutter * (count - 1)) / count;
      const positions: number[] = [];
      for (let i = 0; i < count; i++) {
        const x = i * (colWidth + gutter);
        positions.push(x, x + colWidth);
      }
      pref.setAttribute('ColumnsPositions', positions.map(formatNumber).join(' '));
    }
  }
  // Also the document default margins in Preferences.xml
  const defaults = firstChild(doc.resource('Preferences'), 'MarginPreference');
  if (defaults && !pageRefs) {
    if (m) setAttrs(defaults, { Top: m.top, Bottom: m.bottom, Left: m.left, Right: m.right });
    if (options.columns !== undefined)
      defaults.setAttribute('ColumnCount', String(Math.max(1, Math.floor(options.columns))));
    if (options.gutter !== undefined)
      defaults.setAttribute('ColumnGutter', formatNumber(toPoints(options.gutter, unit)));
  }
}
