// Structural validation: the rules InDesign relies on that are cheap to check without a schema.
import type { IdmlDocument } from './document.ts';
import { readPaths } from './geometry.ts';
import { listPages } from './pages.ts';
import { allElements, attr, children, type Element, numAttr } from './xml.ts';

export interface ValidationIssue {
  level: 'error' | 'warning';
  part: string;
  message: string;
}

const REQUIRED_PARTS = [
  'designmap.xml',
  'META-INF/container.xml',
  'Resources/Fonts.xml',
  'Resources/Graphic.xml',
  'Resources/Preferences.xml',
  'Resources/Styles.xml',
  'XML/BackingStory.xml',
  'XML/Tags.xml',
];

const REF_ATTRS: Record<string, (v: string) => boolean> = {
  ParentStory: (v) => v.startsWith('u'),
  ItemLayer: () => true,
  AppliedMaster: (v) => v !== 'n',
  AppliedParagraphStyle: () => true,
  AppliedCharacterStyle: () => true,
  AppliedObjectStyle: () => true,
  FillColor: () => true,
  StrokeColor: () => true,
  NextTextFrame: (v) => v !== 'n',
  PreviousTextFrame: (v) => v !== 'n',
  AppliedFont: () => false,
};

export function validateDocument(doc: IdmlDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (level: ValidationIssue['level'], part: string, message: string) =>
    issues.push({ level, part, message });

  for (const p of doc.containerProblems) push('error', 'mimetype', p);
  for (const required of REQUIRED_PARTS)
    if (!doc.hasPart(required)) push('error', required, 'Required part is missing');
  if (!doc.hasPart('mimetype')) push('error', 'mimetype', 'mimetype entry is missing');

  // idPkg references must exist, and every XML part should be referenced
  const referenced = new Set<string>([
    'designmap.xml',
    'mimetype',
    'META-INF/container.xml',
    'META-INF/metadata.xml',
  ]);
  for (const ref of doc.partRefs()) {
    referenced.add(ref.src);
    if (!doc.hasPart(ref.src)) push('error', 'designmap.xml', `designmap references missing part ${ref.src}`);
  }
  for (const name of doc.partNames()) {
    if (name.endsWith('.xml') && !referenced.has(name))
      push('warning', name, 'Part is not referenced from designmap.xml (InDesign will ignore it)');
  }

  // DOMVersion consistency
  const version = doc.domVersion;
  for (const name of doc.partNames()) {
    if (!name.endsWith('.xml') || name.startsWith('META-INF/') || name === 'designmap.xml') continue;
    let root: Element | null;
    try {
      root = doc.xml(name).documentElement;
    } catch (e) {
      push('error', name, `Malformed XML: ${(e as Error).message}`);
      continue;
    }
    const v = root ? attr(root, 'DOMVersion') : undefined;
    if (v && v !== version) push('warning', name, `DOMVersion ${v} differs from designmap (${version})`);
  }

  // Collect all Self ids and check uniqueness
  const selfs = new Map<string, string>();
  const refs: { part: string; attr: string; value: string }[] = [];
  for (const name of doc.partNames()) {
    if (!name.endsWith('.xml') || name.startsWith('META-INF/')) continue;
    let root: Element | null;
    try {
      root = doc.xml(name).documentElement;
    } catch {
      continue;
    }
    if (!root) continue;
    for (const el of allElements(root)) {
      const self = attr(el, 'Self');
      if (self) {
        const prev = selfs.get(self);
        // XML structure elements (XMLElement/XMLAttribute, ids "di...") legitimately appear both in the
        // backing story and in the story that holds their content.
        const structural =
          el.tagName === 'XMLElement' || el.tagName === 'XMLAttribute' || el.tagName === 'ListItem';
        if (prev && !structural && !self.includes('/'))
          push('error', name, `Duplicate id ${self}${prev !== name ? ` (also in ${prev})` : ''}`);
        selfs.set(self, name);
      }
      for (const [a, test] of Object.entries(REF_ATTRS)) {
        const v = attr(el, a);
        if (v && v !== 'n' && v !== '' && test(v)) refs.push({ part: name, attr: a, value: v });
      }
      if (el.tagName === 'TextFrame' && !attr(el, 'ParentStory'))
        push('error', name, `Text frame ${self} has no ParentStory`);
      if (['TextFrame', 'Rectangle', 'Oval', 'GraphicLine', 'Polygon', 'Group'].includes(el.tagName)) {
        if (!attr(el, 'ItemLayer') && el.parentNode && (el.parentNode as Element).tagName !== 'Group')
          push('error', name, `${el.tagName} ${self} has no ItemLayer`);
        if (el.tagName !== 'Group') {
          const paths = readPaths(el);
          if (!paths.length) push('error', name, `${el.tagName} ${self} has no PathGeometry`);
          for (const p of paths) {
            if (!p.open && p.points.length < 3)
              push('warning', name, `${el.tagName} ${self} has a closed path with fewer than 3 points`);
            if (p.open && p.points.length < 2)
              push('warning', name, `${el.tagName} ${self} has an open path with fewer than 2 points`);
          }
        }
      }
    }
  }
  const knownStyles = new Set<string>();
  for (const el of allElements(doc.resource('Styles'))) {
    const s = attr(el, 'Self');
    if (s) knownStyles.add(s);
  }
  for (const el of allElements(doc.resource('Graphic'))) {
    const s = attr(el, 'Self');
    if (s) knownStyles.add(s);
  }
  for (const r of refs) {
    if (
      r.attr === 'ParentStory' ||
      r.attr === 'ItemLayer' ||
      r.attr === 'AppliedMaster' ||
      r.attr === 'NextTextFrame' ||
      r.attr === 'PreviousTextFrame'
    ) {
      if (!selfs.has(r.value))
        push('error', r.part, `${r.attr}="${r.value}" points to an object that does not exist`);
    } else if (!knownStyles.has(r.value) && !selfs.has(r.value)) {
      push('error', r.part, `${r.attr}="${r.value}" points to a style or swatch that does not exist`);
    }
  }

  // Stories: every story in StoryList must exist and vice versa
  const storyList = (attr(doc.root, 'StoryList') ?? '').split(/\s+/).filter(Boolean);
  const storyIds = new Set<string>();
  for (const part of doc.storyParts()) {
    const s = children(doc.xml(part).documentElement, 'Story')[0];
    if (!s) push('error', part, 'Story part has no <Story> element');
    else storyIds.add(attr(s, 'Self') ?? '');
  }
  for (const id of storyIds)
    if (!storyList.includes(id)) push('warning', 'designmap.xml', `Story ${id} is missing from StoryList`);
  for (const id of storyList)
    if (!storyIds.has(id) && !selfs.has(id))
      push('warning', 'designmap.xml', `StoryList mentions ${id} which does not exist`);

  // Page counts
  const pages = listPages(doc);
  const dp = children(doc.resource('Preferences'), 'DocumentPreference')[0];
  if (dp) {
    // PagesPerDocument is the New Document dialog's page count, not this document's. InDesign
    // pre-creates that many pages before reading the spreads, so anything above 1 shows up as
    // leading blank pages when the file is opened.
    const declared = numAttr(dp, 'PagesPerDocument', 1);
    if (declared > 1)
      push(
        'error',
        'Resources/Preferences.xml',
        `PagesPerDocument is ${declared}; it must be 1 or InDesign adds ${declared - 1} blank page(s) in front of the document`,
      );
  }
  for (const spread of doc.spreads()) {
    const n = children(spread, 'Page').length;
    if (numAttr(spread, 'PageCount', n) !== n)
      push(
        'warning',
        'Spreads',
        `Spread ${attr(spread, 'Self')} declares PageCount ${attr(spread, 'PageCount')} but has ${n} pages`,
      );
  }
  const sections = children(doc.root, 'Section');
  const sectionTotal = sections.reduce((s, sec) => s + numAttr(sec, 'Length', 0), 0);
  if (sections.length && sectionTotal !== pages.length)
    push(
      'warning',
      'designmap.xml',
      `Sections cover ${sectionTotal} pages but the document has ${pages.length}`,
    );

  // Text frame threading consistency
  for (const part of [...doc.spreadParts(), ...doc.masterSpreadParts()]) {
    for (const f of Array.from(doc.xml(part).getElementsByTagName('TextFrame'))) {
      const next = attr(f, 'NextTextFrame');
      if (next && next !== 'n') {
        const other = doc.findBySelf(next)?.element;
        if (other && attr(other, 'PreviousTextFrame') !== attr(f, 'Self'))
          push(
            'error',
            part,
            `Text frame ${attr(f, 'Self')} threads to ${next} but ${next} does not link back`,
          );
      }
    }
  }
  return issues;
}

export function summarizeIssues(issues: ValidationIssue[]): string {
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  if (!issues.length) return 'No problems found.';
  return `${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
}
