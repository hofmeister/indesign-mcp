// Preflight: the checks a designer runs before sending a document to print or to a client.
import { fontCatalog } from '../preview/fonts.ts';
import { findOversetFrames } from '../preview/svg.ts';
import type { IdmlDocument } from './document.ts';
import type { Rect } from './geometry.ts';
import { listItems } from './items.ts';
import { type LinkRecord, listLinks } from './links.ts';
import { documentPageSize, listPages } from './pages.ts';
import { fontsUsed, listSwatches, swatchElements } from './styles.ts';
import {
  attr,
  children,
  descendants,
  type Element,
  firstChild,
  numAttr,
  type Document as XmlDocument,
} from './xml.ts';

export type Severity = 'error' | 'warning' | 'info';

export interface PreflightIssue {
  check: string;
  severity: Severity;
  message: string;
  page?: number;
  item?: string;
  fix?: string;
}

export interface PreflightOptions {
  /** Minimum effective resolution for placed images (default 250 ppi; 96 for screen). */
  minPpi?: number;
  /** Intended output: print flags RGB colours, screen flags CMYK ones. */
  intent?: 'print' | 'screen';
  /** Smallest acceptable text size in points (default 6). */
  minTextSize?: number;
  /** Objects closer than this to the trim edge are flagged (default 3 mm, in points). */
  safeMargin?: number;
  /** Thinnest acceptable stroke in points (default 0.25). */
  minStrokeWeight?: number;
}

export interface PreflightReport {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: PreflightIssue[];
  checked: string[];
  links: LinkRecord[];
}

function bleedOf(doc: IdmlDocument): number {
  const dp = firstChild(doc.resource('Preferences'), 'DocumentPreference');
  return dp ? numAttr(dp, 'DocumentBleedTopOffset', 0) : 0;
}

function textSizesUsed(doc: IdmlDocument): { size: number; where: string }[] {
  const out: { size: number; where: string }[] = [];
  for (const part of doc.storyParts()) {
    const story = children(doc.xml(part).documentElement, 'Story')[0];
    if (!story) continue;
    for (const range of descendants(story, 'CharacterStyleRange')) {
      const size = numAttr(range, 'PointSize', 0);
      const text = children(range, 'Content')
        .map((c) => c.textContent ?? '')
        .join('')
        .trim();
      if (size > 0 && text) out.push({ size, where: text.slice(0, 40) });
    }
  }
  return out;
}

function itemStrokes(doc: IdmlDocument): { weight: number; item: string; page: number | undefined }[] {
  const out: { weight: number; item: string; page: number | undefined }[] = [];
  const walk = (items: ReturnType<typeof listItems>) => {
    for (const i of items) {
      if (i.strokeWeight > 0 && i.stroke && i.stroke !== 'None')
        out.push({ weight: i.strokeWeight, item: i.name ?? i.id, page: i.page });
      if (i.children) walk(i.children);
    }
  };
  walk(listItems(doc, { includeMasters: true }));
  return out;
}

function outsideSafeArea(bounds: Rect, page: { width: number; height: number }, margin: number): boolean {
  return (
    bounds.x < margin ||
    bounds.y < margin ||
    bounds.x + bounds.width > page.width - margin ||
    bounds.y + bounds.height > page.height - margin
  );
}

function partlyOffPage(bounds: Rect, page: { width: number; height: number }, bleed: number): boolean {
  return (
    bounds.x + bounds.width < -bleed ||
    bounds.y + bounds.height < -bleed ||
    bounds.x > page.width + bleed ||
    bounds.y > page.height + bleed
  );
}

function usesTransparency(doc: IdmlDocument): boolean {
  for (const spread of doc.spreads()) {
    for (const el of descendants(spread, 'BlendingSetting')) {
      if (numAttr(el, 'Opacity', 100) < 100) return true;
      const mode = attr(el, 'BlendMode');
      if (mode && mode !== 'Normal') return true;
    }
    if (descendants(spread, 'DropShadowSetting').some((s: Element) => attr(s, 'Mode') === 'Drop'))
      return true;
  }
  return false;
}

export function preflight(doc: IdmlDocument, options: PreflightOptions = {}): PreflightReport {
  const intent = options.intent ?? 'print';
  const minPpi = options.minPpi ?? (intent === 'print' ? 250 : 96);
  const minTextSize = options.minTextSize ?? 6;
  const safeMargin = options.safeMargin ?? 8.5; // ≈ 3 mm
  const minStroke = options.minStrokeWeight ?? 0.25;
  const issues: PreflightIssue[] = [];
  const checked: string[] = [];
  const add = (i: PreflightIssue) => issues.push(i);

  // --- links -------------------------------------------------------------------------------
  checked.push('Linked images');
  const links = listLinks(doc);
  for (const l of links) {
    if (l.status === 'missing')
      add({
        check: 'missing-link',
        severity: 'error',
        message: `Linked image is missing: ${l.path || l.fileName}`,
        page: l.page,
        item: l.frameName ?? l.frame,
        fix: 'Use relink_image to point it at the file, or place the image again.',
      });
    else if (l.status === 'modified')
      add({
        check: 'modified-link',
        severity: 'warning',
        message: `${l.fileName} has changed on disk since it was placed`,
        page: l.page,
        item: l.frameName ?? l.frame,
        fix: 'InDesign will ask to update the link when you open the document.',
      });
  }

  checked.push('Image resolution');
  for (const l of links) {
    if (!l.exists && !l.embedded) continue;
    if (l.effectivePpi && l.effectivePpi < minPpi) {
      add({
        check: 'low-resolution',
        severity: l.effectivePpi < minPpi * 0.6 ? 'error' : 'warning',
        message: `${l.fileName} prints at ${l.effectivePpi} ppi (${l.scalePercent}% scale); ${minPpi} ppi recommended`,
        page: l.page,
        item: l.frameName ?? l.frame,
        fix: 'Use a larger image, or make the frame smaller.',
      });
    }
    if (['gif', 'webp'].includes(l.format) && intent === 'print') {
      add({
        check: 'image-format',
        severity: 'warning',
        message: `${l.fileName} is a ${l.format.toUpperCase()}; use TIFF, PSD, PNG or JPEG for print`,
        page: l.page,
        item: l.frameName ?? l.frame,
        fix: 'Convert the image and relink it.',
      });
    }
  }

  // --- text --------------------------------------------------------------------------------
  checked.push('Overset text');
  for (const o of findOversetFrames(doc)) {
    add({
      check: 'overset-text',
      severity: 'error',
      message: `Text does not fit in "${o.name ?? o.frame}"${o.text ? `: “${o.text}…”` : ''}`,
      page: o.page,
      item: o.name ?? o.frame,
      fix: 'Make the frame bigger, shorten the text, or thread it into another frame.',
    });
  }

  checked.push('Small text');
  for (const t of textSizesUsed(doc)) {
    if (t.size < minTextSize)
      add({
        check: 'small-text',
        severity: 'warning',
        message: `Text at ${t.size} pt is smaller than ${minTextSize} pt: “${t.where}”`,
        fix: 'Increase the size, or accept it for legal small print.',
      });
  }

  checked.push('Fonts');
  const catalog = fontCatalog();
  for (const font of fontsUsed(doc)) {
    // A preflight is a report: a font this computer cannot read is something to say, never a
    // reason for the whole check to fail.
    let match: ReturnType<typeof catalog.match> | undefined;
    try {
      match = catalog.match(font, 'Regular');
    } catch (e) {
      add({
        check: 'font-unreadable',
        severity: 'warning',
        message: `Font "${font}" could not be checked on this computer: ${(e as Error).message}`,
      });
      continue;
    }
    if (match.substituted)
      add({
        check: 'missing-font',
        severity: 'warning',
        message: `Font "${font}" is not installed on this computer (previews use ${match.info.family})`,
        fix: 'Install the font before opening the document in InDesign, or change the style.',
      });
  }

  // --- colour ------------------------------------------------------------------------------
  checked.push('Colours');
  // Only judge swatches the document actually uses. A template ships a few stock swatches nobody
  // asked for, and warning about those buries the ones that matter.
  const usedSwatches = referencedSwatches(doc);
  for (const s of listSwatches(doc)) {
    if (s.builtIn || s.kind !== 'color') continue;
    if (!usedSwatches.has(s.self)) continue;
    if (intent === 'print' && s.space === 'RGB')
      add({
        check: 'rgb-swatch',
        severity: 'warning',
        message: `Swatch "${s.name}" is RGB; print work is normally CMYK or a spot colour`,
        fix: 'Recreate the swatch with cmyk(...) values.',
      });
    if (intent === 'screen' && s.space === 'CMYK')
      add({
        check: 'cmyk-swatch',
        severity: 'info',
        message: `Swatch "${s.name}" is CMYK; screen output is RGB`,
      });
    if (s.model === 'Spot')
      add({
        check: 'spot-colour',
        severity: 'info',
        message: `Swatch "${s.name}" is a spot colour — it prints on its own plate`,
      });
  }

  // --- geometry ----------------------------------------------------------------------------
  checked.push('Objects near the trim edge');
  const size = documentPageSize(doc);
  const bleed = bleedOf(doc);
  const pages = listPages(doc);
  for (const item of listItems(doc)) {
    if (!item.bounds || item.page === undefined) continue;
    const page = pages.find((p) => p.index === item.page);
    const dims = page ? { width: page.width, height: page.height } : size;
    if (partlyOffPage(item.bounds, dims, bleed)) {
      add({
        check: 'off-page',
        severity: 'info',
        message: `"${item.name ?? item.id}" sits entirely outside the page (on the pasteboard)`,
        page: item.page,
        item: item.name ?? item.id,
      });
      continue;
    }
    const touchesEdge =
      item.bounds.x < 0 ||
      item.bounds.y < 0 ||
      item.bounds.x + item.bounds.width > dims.width ||
      item.bounds.y + item.bounds.height > dims.height;
    if (touchesEdge && bleed === 0) {
      add({
        check: 'no-bleed',
        severity: 'warning',
        message: `"${item.name ?? item.id}" runs off the page but the document has no bleed`,
        page: item.page,
        item: item.name ?? item.id,
        fix: 'Set a bleed (usually 3 mm) with set_document_preferences and extend the object into it.',
      });
    } else if (!touchesEdge && item.type === 'text' && outsideSafeArea(item.bounds, dims, safeMargin)) {
      add({
        check: 'close-to-edge',
        severity: 'info',
        message: `Text frame "${item.name ?? item.id}" is closer than ${Math.round(safeMargin / 2.835)} mm to the trim edge`,
        page: item.page,
        item: item.name ?? item.id,
      });
    }
  }

  checked.push('Hairlines');
  for (const s of itemStrokes(doc)) {
    if (s.weight < minStroke)
      add({
        check: 'hairline',
        severity: 'warning',
        message: `"${s.item}" has a ${s.weight} pt stroke; anything under ${minStroke} pt may disappear in print`,
        page: s.page,
        item: s.item,
      });
  }

  checked.push('Empty frames');
  for (const item of listItems(doc)) {
    // A frame whose story holds only a table has no plain text, but it is not empty.
    if (item.type === 'text' && !(item.text ?? '').trim() && item.tables === 0)
      add({
        check: 'empty-frame',
        severity: 'info',
        message: `Text frame "${item.name ?? item.id}" is empty`,
        page: item.page,
        item: item.name ?? item.id,
      });
  }

  checked.push('Transparency');
  if (intent === 'print' && usesTransparency(doc))
    add({
      check: 'transparency',
      severity: 'info',
      message:
        'The document uses transparency (opacity, blend modes or drop shadows) — ask your printer about flattening',
    });

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  return { ok: errors === 0, errors, warnings, issues, checked, links };
}

/**
 * Self ids of the swatches referenced anywhere in the document — by page items, text runs, styles
 * or gradients. An unused swatch sits in the panel without ever reaching the page.
 */
function referencedSwatches(doc: IdmlDocument): Set<string> {
  const swatchIds = new Set(swatchElements(doc).map((el) => attr(el, 'Self') ?? ''));
  const graphicParts = new Set(doc.partRefs('Graphic').map((r) => r.src));
  const used = new Set<string>();

  // Everything outside the swatch resource itself, which holds only the definitions.
  for (const part of doc.partNames()) {
    if (graphicParts.has(part)) continue;
    let xml: XmlDocument;
    try {
      xml = doc.xml(part);
    } catch {
      continue;
    }
    const walk = (el: Element): void => {
      // <ColorGroupSwatch> is the swatch *panel*: it names every swatch in the document, used or
      // not, so counting it would make every swatch look used.
      if (el.tagName === 'ColorGroupSwatch') return;
      for (let i = 0; i < (el.attributes?.length ?? 0); i++) {
        const a = el.attributes?.item(i);
        if (!a || a.name === 'Self') continue;
        if (swatchIds.has(a.value)) used.add(a.value);
      }
      for (const c of children(el)) walk(c);
    };
    if (xml.documentElement) walk(xml.documentElement);
  }

  // A gradient that is used puts its stop colours on the page too.
  for (const el of swatchElements(doc)) {
    const self = attr(el, 'Self') ?? '';
    if (el.tagName !== 'Gradient' || !used.has(self)) continue;
    for (const stop of descendants(el, 'GradientStop')) {
      const ref = attr(stop, 'StopColor');
      if (ref && swatchIds.has(ref)) used.add(ref);
    }
  }
  return used;
}

export function preflightToMarkdown(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push(
    report.errors
      ? `${report.errors} problem(s) to fix and ${report.warnings} warning(s).`
      : report.warnings
        ? `No blocking problems. ${report.warnings} warning(s) worth a look.`
        : 'No problems found.',
  );
  const order: Severity[] = ['error', 'warning', 'info'];
  for (const sev of order) {
    const group = report.issues.filter((i) => i.severity === sev);
    if (!group.length) continue;
    lines.push(
      '',
      sev === 'error' ? '**Must fix**' : sev === 'warning' ? '**Should check**' : '**For information**',
    );
    for (const i of group) {
      const where = i.page ? ` (page ${i.page})` : '';
      lines.push(`- ${i.message}${where}${i.fix ? ` — ${i.fix}` : ''}`);
    }
  }
  lines.push('', `Checked: ${report.checked.join(', ')}.`);
  return lines.join('\n');
}
