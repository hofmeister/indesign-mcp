// Copies styles, swatches, fonts, master pages and pages from one document into another,
// giving every copied object fresh ids and repairing references.
import type { IdmlDocument } from '../idml/document.ts';
import { isPageItem, itemSpreadBounds, translateItem } from '../idml/items.ts';
import { createLayer, findLayer, layerElements } from '../idml/layers.ts';
import { addPages, findPage, listPages, type PageInfo, pageForSpreadRect } from '../idml/pages.ts';
import { pruneUnknownForSchema } from '../idml/schema.ts';
import { type StyleKind, styleElements, swatchElements } from '../idml/styles.ts';
import {
  allElements,
  attr,
  children,
  createIdPkgRef,
  type Element,
  firstChild,
  insertAfter,
} from '../idml/xml.ts';

export type ConflictPolicy = 'skip' | 'overwrite' | 'rename';

export interface ImportStylesOptions {
  paragraph?: boolean;
  character?: boolean;
  object?: boolean;
  swatches?: boolean;
  fonts?: boolean;
  /** Only these style names (any kind). */
  only?: string[];
  conflict?: ConflictPolicy;
}

export interface ImportReport {
  paragraphStyles: string[];
  characterStyles: string[];
  objectStyles: string[];
  swatches: string[];
  fonts: string[];
  skipped: string[];
  warnings: string[];
}

/**
 * After copying content from a newer InDesign version, drop attributes/elements the target's own
 * IDML version does not know so the file stays valid for that version.
 */
function pruneForTarget(to: IdmlDocument, parts: string[], report: ImportReport): void {
  try {
    const r = pruneUnknownForSchema(to, { parts });
    if (r.attributesRemoved || r.elementsRemoved) {
      report.warnings.push(
        `Removed ${r.attributesRemoved} attribute(s) and ${r.elementsRemoved} element(s) that IDML ${to.domVersion} does not support (copied from a newer InDesign version).`,
      );
    }
  } catch (e) {
    report.warnings.push(`Schema clean-up skipped: ${(e as Error).message}`);
  }
}

function resourceParts(to: IdmlDocument): string[] {
  return ['Styles', 'Graphic', 'Fonts'].map(
    (k) => to.partRefs(k as 'Styles' | 'Graphic' | 'Fonts')[0]?.src ?? `Resources/${k}.xml`,
  );
}

const REF_ATTRS = [
  'FillColor',
  'StrokeColor',
  'GapColor',
  'RuleAboveColor',
  'RuleBelowColor',
  'UnderlineColor',
  'StrikeThroughColor',
  'ParagraphShadingColor',
  'ParagraphBorderColor',
  'BulletsCharacterStyle',
  'NumberingCharacterStyle',
  'AppliedCharacterStyle',
  'AppliedParagraphStyle',
  'AppliedObjectStyle',
  'NextStyle',
  'AppliedFont',
  'ColumnRuleStrokeColor',
];

function nameOf(el: Element): string {
  return attr(el, 'Name') ?? '';
}

/** Copies swatches referenced anywhere inside `subtree` from `from` to `to` (by Self). */
function ensureSwatches(
  from: IdmlDocument,
  to: IdmlDocument,
  subtree: Element[],
  report: ImportReport,
): void {
  const targetGraphic = to.resource('Graphic');
  const have = new Set(swatchElements(to).map((s) => attr(s, 'Self')));
  const sourceSwatches = new Map(swatchElements(from).map((s) => [attr(s, 'Self')!, s]));
  const needed = new Set<string>();
  for (const root of subtree) {
    for (const el of allElements(root)) {
      for (const a of REF_ATTRS) {
        const v = attr(el, a);
        if (v && /^(Color|Gradient|MixedInk|Tint|Swatch)\//.test(v)) needed.add(v);
      }
      // typed properties such as <FillColor type="object">Color/x</FillColor>
      if (el.tagName === 'Properties')
        for (const p of children(el))
          if (/^(Color|Gradient|MixedInk|Tint)\//.test(p.textContent ?? ''))
            needed.add(p.textContent!.trim());
    }
  }
  for (const self of needed) {
    if (have.has(self)) continue;
    const src = sourceSwatches.get(self);
    if (!src) continue;
    const clone = targetGraphic.ownerDocument!.importNode(src, true) as Element;
    if (clone.tagName === 'Gradient') {
      for (const stop of children(clone, 'GradientStop')) stop.setAttribute('Self', to.newId());
    }
    clone.removeAttribute('SwatchColorGroupReference');
    insertAfter(
      targetGraphic,
      clone,
      children(targetGraphic, clone.tagName).at(-1) ?? children(targetGraphic).at(-1),
    );
    have.add(self);
    report.swatches.push(nameOf(clone));
    // gradients reference colors
    if (clone.tagName === 'Gradient') ensureSwatches(from, to, [clone], report);
  }
}

function ensureFonts(from: IdmlDocument, to: IdmlDocument, subtree: Element[], report: ImportReport): void {
  const targetFonts = to.resource('Fonts');
  const have = new Set(children(targetFonts, 'FontFamily').map(nameOf));
  const source = new Map(children(from.resource('Fonts'), 'FontFamily').map((f) => [nameOf(f), f]));
  const needed = new Set<string>();
  for (const root of subtree)
    for (const el of allElements(root))
      if (el.tagName === 'AppliedFont' && el.textContent?.trim()) needed.add(el.textContent.trim());
  for (const fam of needed) {
    if (have.has(fam)) continue;
    const src = source.get(fam);
    if (!src) continue;
    const clone = targetFonts.ownerDocument!.importNode(src, true) as Element;
    clone.setAttribute('Self', to.newId());
    for (const f of children(clone, 'Font'))
      f.setAttribute('Self', `${attr(clone, 'Self')}Fontn${nameOf(f)}`);
    insertAfter(targetFonts, clone, children(targetFonts, 'FontFamily').at(-1));
    have.add(fam);
    report.fonts.push(fam);
  }
}

function groupPathOf(el: Element, kind: StyleKind): string[] {
  const path: string[] = [];
  let p = el.parentNode as Element | null;
  while (p && p.tagName === `${kind}Group`) {
    path.unshift(nameOf(p));
    p = p.parentNode as Element | null;
  }
  return path;
}

function groupContainerIn(to: IdmlDocument, kind: StyleKind, path: string[]): Element {
  const rootName = {
    ParagraphStyle: 'RootParagraphStyleGroup',
    CharacterStyle: 'RootCharacterStyleGroup',
    ObjectStyle: 'RootObjectStyleGroup',
    TableStyle: 'RootTableStyleGroup',
    CellStyle: 'RootCellStyleGroup',
  }[kind];
  const styles = to.resource('Styles');
  let root = firstChild(styles, rootName);
  if (!root) {
    root = styles.ownerDocument!.createElement(rootName);
    root.setAttribute('Self', to.newId());
    insertAfter(styles, root);
  }
  let container: Element = root;
  for (const segment of path) {
    let g: Element | undefined = children(container, `${kind}Group`).find((x) => nameOf(x) === segment);
    if (!g) {
      const created: Element = container.ownerDocument!.createElement(`${kind}Group`);
      created.setAttribute('Self', to.newId());
      created.setAttribute('Name', segment);
      insertAfter(container, created);
      g = created;
    }
    container = g;
  }
  return container;
}

function importStyleKind(
  from: IdmlDocument,
  to: IdmlDocument,
  kind: StyleKind,
  opts: ImportStylesOptions,
  report: ImportReport,
  list: string[],
): void {
  const existing = new Map(styleElements(to, kind).map((s) => [attr(s.element, 'Self')!, s.element]));
  const sources = styleElements(from, kind).filter((s) => !nameOf(s.element).startsWith('$ID/'));
  const only = opts.only;
  const exactNames = new Set(sources.map((s) => nameOf(s.element)));
  // Exact-case match wins; fall back to case-insensitive only when no style has that exact name.
  const onlyMatches = (el: Element): boolean => {
    if (!only) return true;
    const name = nameOf(el);
    return only.some((n) => (exactNames.has(n) ? n === name : n.toLowerCase() === name.toLowerCase()));
  };
  const imported: Element[] = [];
  // Copy in dependency order: BasedOn parents first
  const bySelf = new Map(sources.map((s) => [attr(s.element, 'Self')!, s.element]));
  const done = new Set<string>();
  const visit = (el: Element) => {
    const self = attr(el, 'Self')!;
    if (done.has(self)) return;
    done.add(self);
    const basedOn = firstChild(firstChild(el, 'Properties'), 'BasedOn')?.textContent?.trim();
    if (basedOn) {
      const parent =
        sources.find((s) => nameOf(s.element) === basedOn)?.element ?? bySelf.get(`${kind}/${basedOn}`);
      if (parent) visit(parent);
    }
    if (!onlyMatches(el)) return;
    const path = groupPathOf(el, kind);
    const container = groupContainerIn(to, kind, path);
    const target = existing.get(self);
    const clone = container.ownerDocument!.importNode(el, true) as Element;
    if (target) {
      const policy = opts.conflict ?? 'skip';
      if (policy === 'skip') {
        report.skipped.push(
          `${kind.replace('Style', ' style').toLowerCase()} "${nameOf(el)}" (already exists)`,
        );
        return;
      }
      if (policy === 'rename') {
        let n = 2;
        let name = `${nameOf(el)} ${n}`;
        while (styleElements(to, kind).some((s) => nameOf(s.element) === name)) name = `${nameOf(el)} ${++n}`;
        clone.setAttribute('Name', name);
        clone.setAttribute('Self', `${kind}/${name}`);
        if (clone.hasAttribute('NextStyle') && attr(clone, 'NextStyle') === self)
          clone.setAttribute('NextStyle', attr(clone, 'Self')!);
      } else {
        target.parentNode?.replaceChild(clone, target);
        imported.push(clone);
        list.push(nameOf(clone));
        return;
      }
    }
    insertAfter(container, clone, children(container, kind).at(-1));
    imported.push(clone);
    list.push(nameOf(clone));
  };
  for (const s of sources) visit(s.element);
  ensureSwatches(from, to, imported, report);
  ensureFonts(from, to, imported, report);
  // character styles referenced by paragraph styles must exist
  if (kind === 'ParagraphStyle') {
    const needCs = new Set<string>();
    for (const el of imported)
      for (const a of ['BulletsCharacterStyle', 'NumberingCharacterStyle'])
        if (attr(el, a)?.startsWith('CharacterStyle/')) needCs.add(attr(el, a)!);
    for (const cs of needCs) {
      if (!styleElements(to, 'CharacterStyle').some((s) => attr(s.element, 'Self') === cs)) {
        const src = styleElements(from, 'CharacterStyle').find(
          (s) => attr(s.element, 'Self') === cs,
        )?.element;
        if (src) {
          const container = groupContainerIn(to, 'CharacterStyle', groupPathOf(src, 'CharacterStyle'));
          const clone = container.ownerDocument!.importNode(src, true) as Element;
          insertAfter(container, clone, children(container, 'CharacterStyle').at(-1));
          report.characterStyles.push(nameOf(clone));
        }
      }
    }
  }
}

export function importStyles(
  from: IdmlDocument,
  to: IdmlDocument,
  opts: ImportStylesOptions = {},
): ImportReport {
  const report: ImportReport = {
    paragraphStyles: [],
    characterStyles: [],
    objectStyles: [],
    swatches: [],
    fonts: [],
    skipped: [],
    warnings: [],
  };
  const all =
    opts.paragraph === undefined &&
    opts.character === undefined &&
    opts.object === undefined &&
    opts.swatches === undefined &&
    opts.fonts === undefined;
  if (all || opts.character)
    importStyleKind(from, to, 'CharacterStyle', opts, report, report.characterStyles);
  if (all || opts.paragraph)
    importStyleKind(from, to, 'ParagraphStyle', opts, report, report.paragraphStyles);
  if (all || opts.object) importStyleKind(from, to, 'ObjectStyle', opts, report, report.objectStyles);
  if (all || opts.swatches) {
    const have = new Set(swatchElements(to).map(nameOf));
    const targetGraphic = to.resource('Graphic');
    for (const s of swatchElements(from)) {
      const name = nameOf(s);
      if (have.has(name) || attr(s, 'ColorRemovable') === 'false' || name.startsWith('$ID/')) continue;
      if (opts.only && !opts.only.map((n) => n.toLowerCase()).includes(name.toLowerCase())) continue;
      const clone = targetGraphic.ownerDocument!.importNode(s, true) as Element;
      clone.removeAttribute('SwatchColorGroupReference');
      if (clone.tagName === 'Gradient')
        for (const stop of children(clone, 'GradientStop')) stop.setAttribute('Self', to.newId());
      insertAfter(
        targetGraphic,
        clone,
        children(targetGraphic, clone.tagName).at(-1) ?? children(targetGraphic).at(-1),
      );
      have.add(name);
      report.swatches.push(name);
    }
  }
  if (all || opts.fonts) {
    const targetFonts = to.resource('Fonts');
    const have = new Set(children(targetFonts, 'FontFamily').map(nameOf));
    for (const fam of children(from.resource('Fonts'), 'FontFamily')) {
      if (have.has(nameOf(fam))) continue;
      const clone = targetFonts.ownerDocument!.importNode(fam, true) as Element;
      insertAfter(targetFonts, clone, children(targetFonts, 'FontFamily').at(-1));
      report.fonts.push(nameOf(fam));
    }
  }
  pruneForTarget(to, resourceParts(to), report);
  return report;
}

// ---- masters and pages ------------------------------------------------------------------------

function ensureLayers(from: IdmlDocument, to: IdmlDocument, subtree: Element[]): Map<string, string> {
  const map = new Map<string, string>();
  const sourceLayers = new Map(layerElements(from).map((l) => [attr(l, 'Self')!, l]));
  for (const root of subtree) {
    for (const el of allElements(root)) {
      const layerId = attr(el, 'ItemLayer');
      if (!layerId || map.has(layerId)) continue;
      const src = sourceLayers.get(layerId);
      const name = src ? nameOf(src) : 'Layer 1';
      let target = findLayer(to, name);
      if (!target) {
        const info = createLayer(to, name, {
          color: firstChild(firstChild(src!, 'Properties'), 'LayerColor')?.textContent ?? undefined,
        });
        target = findLayer(to, info.id)!;
      }
      map.set(layerId, attr(target, 'Self')!);
    }
  }
  return map;
}

/** Deep-clones `el` into `to`'s document `intoDoc`, giving fresh ids and fixing internal references. */
function cloneWithNewIds(
  from: IdmlDocument,
  to: IdmlDocument,
  el: Element,
  intoDoc: import('../idml/xml.ts').Document,
  warnings: string[],
): Element {
  const clone = intoDoc.importNode(el, true) as Element;
  const idMap = new Map<string, string>();
  const nodes = allElements(clone);
  for (const n of nodes) {
    const self = attr(n, 'Self');
    if (self && !self.includes('/')) {
      const fresh = to.newId();
      idMap.set(self, fresh);
      n.setAttribute('Self', fresh);
    }
  }
  // copy stories used by text frames
  const storyMap = new Map<string, string>();
  for (const n of nodes) {
    if (n.tagName !== 'TextFrame') continue;
    const storyId = attr(n, 'ParentStory');
    if (!storyId) continue;
    let newStory = storyMap.get(storyId);
    if (!newStory) {
      const src = from.story(storyId);
      if (!src) {
        warnings.push(`Story ${storyId} of a copied text frame was not found`);
        continue;
      }
      newStory = copyStory(from, to, src, warnings);
      storyMap.set(storyId, newStory);
    }
    n.setAttribute('ParentStory', newStory);
  }
  // remap internal references (threading, groups, etc.)
  for (const n of nodes) {
    for (let i = 0; i < n.attributes.length; i++) {
      const a = n.attributes.item(i)!;
      if (a.name === 'Self' || a.name === 'ParentStory') continue;
      const mapped = idMap.get(a.value);
      if (mapped) n.setAttribute(a.name, mapped);
    }
  }
  return clone;
}

function copyStory(from: IdmlDocument, to: IdmlDocument, story: Element, warnings: string[]): string {
  const { createStory } = require('../idml/stories.ts') as typeof import('../idml/stories.ts');
  const copy = createStory(to, { text: '' });
  while (copy.firstChild) copy.removeChild(copy.firstChild);
  for (const c of Array.from(story.childNodes)) copy.appendChild(copy.ownerDocument!.importNode(c, true));
  // XML structure elements inside stories refer to the source document's XML tree; strip them to plain ranges.
  for (const x of Array.from(copy.getElementsByTagName('XMLElement')) as Element[]) {
    const parent = x.parentNode;
    if (!parent) continue;
    while (x.firstChild) parent.insertBefore(x.firstChild, x);
    parent.removeChild(x);
  }
  for (const x of Array.from(copy.getElementsByTagName('XMLAttribute')) as Element[])
    x.parentNode?.removeChild(x);
  // swatches, styles and fonts used by the text
  const report: ImportReport = {
    paragraphStyles: [],
    characterStyles: [],
    objectStyles: [],
    swatches: [],
    fonts: [],
    skipped: [],
    warnings,
  };
  ensureStylesFor(from, to, [copy], report);
  return attr(copy, 'Self')!;
}

/** Imports the styles, swatches and fonts referenced inside `subtree` (skipping ones that exist). */
function ensureStylesFor(
  from: IdmlDocument,
  to: IdmlDocument,
  subtree: Element[],
  report: ImportReport,
): void {
  const needed: Record<StyleKind, Set<string>> = {
    ParagraphStyle: new Set(),
    CharacterStyle: new Set(),
    ObjectStyle: new Set(),
    TableStyle: new Set(),
    CellStyle: new Set(),
  };
  for (const root of subtree) {
    for (const el of allElements(root)) {
      for (const [a, kind] of [
        ['AppliedParagraphStyle', 'ParagraphStyle'],
        ['AppliedCharacterStyle', 'CharacterStyle'],
        ['AppliedObjectStyle', 'ObjectStyle'],
        ['AppliedTableStyle', 'TableStyle'],
        ['AppliedCellStyle', 'CellStyle'],
      ] as [string, StyleKind][]) {
        const v = attr(el, a);
        if (v && !v.includes('/$ID/')) needed[kind].add(v);
      }
    }
  }
  for (const kind of Object.keys(needed) as StyleKind[]) {
    const names: string[] = [];
    const have = new Set(styleElements(to, kind).map((s) => attr(s.element, 'Self')));
    for (const self of needed[kind]) {
      if (have.has(self)) continue;
      const src = styleElements(from, kind).find((s) => attr(s.element, 'Self') === self);
      if (src) names.push(nameOf(src.element));
    }
    if (names.length)
      importStyleKind(
        from,
        to,
        kind,
        { only: names, conflict: 'skip' },
        report,
        kind === 'ParagraphStyle'
          ? report.paragraphStyles
          : kind === 'CharacterStyle'
            ? report.characterStyles
            : report.objectStyles,
      );
  }
  ensureSwatches(from, to, subtree, report);
  ensureFonts(from, to, subtree, report);
}

export interface CopyMasterResult {
  id: string;
  name: string;
  report: ImportReport;
}

export function copyMaster(
  from: IdmlDocument,
  to: IdmlDocument,
  masterRef: string,
  options: { prefix?: string; name?: string } = {},
): CopyMasterResult {
  const { resolveMaster } = require('../idml/pages.ts') as typeof import('../idml/pages.ts');
  const sourceId = resolveMaster(from, masterRef);
  const sourcePart = from
    .masterSpreadParts()
    .find((p) => attr(children(from.xml(p).documentElement, 'MasterSpread')[0]!, 'Self') === sourceId);
  if (!sourcePart) throw new Error(`Master "${masterRef}" not found in the reference`);
  const source = children(from.xml(sourcePart).documentElement, 'MasterSpread')[0]!;
  const report: ImportReport = {
    paragraphStyles: [],
    characterStyles: [],
    objectStyles: [],
    swatches: [],
    fonts: [],
    skipped: [],
    warnings: [],
  };
  const partDoc = to.newPartDocument('MasterSpread');
  const clone = cloneWithNewIds(from, to, source, partDoc, report.warnings);
  const prefix = options.prefix ?? attr(source, 'NamePrefix') ?? 'A';
  const base = options.name ?? attr(source, 'BaseName') ?? 'Master';
  // avoid clashing prefixes
  let finalPrefix = prefix;
  const usedPrefixes = new Set(to.masterSpreads().map((m) => attr(m, 'NamePrefix')));
  let code = finalPrefix.charCodeAt(0);
  while (usedPrefixes.has(finalPrefix)) finalPrefix = String.fromCharCode(++code);
  clone.setAttribute('NamePrefix', finalPrefix);
  clone.setAttribute('BaseName', base);
  clone.setAttribute('Name', `${finalPrefix}-${base}`);
  for (const page of children(clone, 'Page')) page.setAttribute('Name', finalPrefix);
  const layerMap = ensureLayers(from, to, [clone]);
  for (const el of allElements(clone)) {
    const l = attr(el, 'ItemLayer');
    if (l && layerMap.has(l)) el.setAttribute('ItemLayer', layerMap.get(l)!);
  }
  ensureStylesFor(from, to, [clone], report);
  const id = attr(clone, 'Self')!;
  const part = `MasterSpreads/MasterSpread_${id}.xml`;
  partDoc.documentElement!.appendChild(partDoc.createTextNode('\n\t'));
  partDoc.documentElement!.appendChild(clone);
  partDoc.documentElement!.appendChild(partDoc.createTextNode('\n'));
  to.addXmlPart(part, partDoc);
  const ref = createIdPkgRef(to.designmap, 'MasterSpread', part);
  const refs = children(to.root).filter((c) => c.tagName === 'idPkg:MasterSpread');
  insertAfter(
    to.root,
    ref,
    refs.at(-1) ??
      children(to.root).find((c) => c.tagName === 'idPkg:Preferences' || c.tagName === 'idPkg:Tags'),
  );
  pruneForTarget(to, [part, ...resourceParts(to), ...to.storyParts()], report);
  return { id, name: `${finalPrefix}-${base}`, report };
}

export interface CopyPageResult {
  page: PageInfo;
  items: number;
  report: ImportReport;
}

/** Copies all items of a reference page onto a new page appended to `to` (or onto an existing page). */
export function copyPage(
  from: IdmlDocument,
  to: IdmlDocument,
  pageRef: number | string,
  options: { ontoPage?: number | string; applyMaster?: boolean } = {},
): CopyPageResult {
  const src = findPage(from, pageRef);
  const report: ImportReport = {
    paragraphStyles: [],
    characterStyles: [],
    objectStyles: [],
    swatches: [],
    fonts: [],
    skipped: [],
    warnings: [],
  };
  let dest: PageInfo;
  if (options.ontoPage !== undefined) dest = findPage(to, options.ontoPage);
  else dest = addPages(to, { count: 1 })[0]!;
  const sourceSpread = children(from.xml(src.spreadPart).documentElement, 'Spread')[0]!;
  const destSpread = children(to.xml(dest.spreadPart).documentElement, 'Spread')[0]!;
  const sourcePages = listPages(from);
  let count = 0;
  const clones: Element[] = [];
  for (const item of children(sourceSpread)) {
    if (!isPageItem(item)) continue;
    const b = itemSpreadBounds(item);
    if (!b) continue;
    if (pageForSpreadRect(sourcePages, src.spreadId, b)?.id !== src.id) continue;
    const clone = cloneWithNewIds(from, to, item, destSpread.ownerDocument!, report.warnings);
    translateItem(clone, dest.origin.x - src.origin.x, dest.origin.y - src.origin.y);
    insertAfter(destSpread, clone);
    clones.push(clone);
    count++;
  }
  const layerMap = ensureLayers(from, to, clones);
  for (const c of clones)
    for (const el of allElements(c)) {
      const l = attr(el, 'ItemLayer');
      if (l && layerMap.has(l)) el.setAttribute('ItemLayer', layerMap.get(l)!);
    }
  ensureStylesFor(from, to, clones, report);
  if (options.applyMaster !== false && src.appliedMaster) {
    const srcMaster = from.masterSpreads().find((m) => attr(m, 'Self') === src.appliedMaster);
    if (srcMaster) {
      const name = attr(srcMaster, 'Name') ?? '';
      let target = to.masterSpreads().find((m) => attr(m, 'Name') === name);
      if (!target) {
        const copied = copyMaster(from, to, src.appliedMaster);
        report.warnings.push(...copied.report.warnings);
        target = to.masterSpreads().find((m) => attr(m, 'Self') === copied.id);
      }
      const pageEl = to.findBySelf(dest.id)?.element;
      if (pageEl && target) pageEl.setAttribute('AppliedMaster', attr(target, 'Self')!);
    }
  }
  if (Math.abs(src.width - dest.width) > 0.5 || Math.abs(src.height - dest.height) > 0.5) {
    report.warnings.push(
      `The reference page is ${Math.round(src.width)}×${Math.round(src.height)} pt but this document's pages are ${Math.round(dest.width)}×${Math.round(dest.height)} pt; items keep their position from the top-left corner.`,
    );
  }
  // linked images: warn when the file does not exist
  for (const c of clones) {
    for (const link of Array.from(c.getElementsByTagName('Link')) as Element[]) {
      const uri = attr(link, 'LinkResourceURI');
      if (!uri) continue;
      const { linkUriToPath } = require('../idml/items.ts') as typeof import('../idml/items.ts');
      const p = linkUriToPath(uri);
      if (!require('node:fs').existsSync(p))
        report.warnings.push(
          `Linked image not found on this computer: ${p} (InDesign will show it as missing until relinked)`,
        );
    }
  }
  pruneForTarget(
    to,
    [dest.spreadPart, ...to.masterSpreadParts(), ...resourceParts(to), ...to.storyParts()],
    report,
  );
  return { page: listPages(to).find((p) => p.id === dest.id)!, items: count, report };
}
