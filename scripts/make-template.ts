// Derives the bundled blank template (src/idml/template/blank.idml) from a real InDesign export.
// Usage: bun run scripts/make-template.ts [source.idml]
// Everything content-specific is stripped: page items, stories, XML tags/structure, custom
// styles, swatches and fonts. Defaults (styles, swatches, preferences, one master, one page) stay.
import { writeFileSync } from 'node:fs';
import { IdmlDocument } from '../src/idml/document.ts';
import { listPages, removeItemElement, removePages } from '../src/idml/pages.ts';
import { attr, children, type Element, removeElement } from '../src/idml/xml.ts';

const source = process.argv[2] ?? 'test/fixtures/idml/interview.idml';
const out = 'src/idml/template/blank.idml';
const doc = IdmlDocument.load(source);

// 1. one page only
const pages = listPages(doc);
if (pages.length > 1)
  removePages(
    doc,
    pages.slice(1).map((p) => p.index),
  );

// 2. remove every page item on spreads and masters (and their stories)
for (const container of [...doc.spreads(), ...doc.masterSpreads()]) {
  for (const item of children(container)) {
    if (!['Page', 'FlattenerPreference', 'Properties'].includes(item.tagName)) removeItemElement(doc, item);
  }
}
// leftover stories (not referenced by any frame)
for (const part of doc.storyParts()) {
  doc.removePart(part);
  const ref = children(doc.root).find((c) => c.tagName === 'idPkg:Story' && attr(c, 'src') === part);
  if (ref) removeElement(ref);
}
doc.root.setAttribute(
  'StoryList',
  attr(children(doc.xml('XML/BackingStory.xml').documentElement!, 'XmlStory')[0]!, 'Self') ?? '',
);

// 3. reset the backing story to an empty Root element
const backing = children(doc.xml('XML/BackingStory.xml').documentElement!, 'XmlStory')[0]!;
for (const c of children(backing)) if (c.tagName === 'ParagraphStyleRange') removeElement(c);
const psr = doc.xml('XML/BackingStory.xml').createElement('ParagraphStyleRange');
psr.setAttribute('AppliedParagraphStyle', 'ParagraphStyle/$ID/NormalParagraphStyle');
const csr = doc.xml('XML/BackingStory.xml').createElement('CharacterStyleRange');
csr.setAttribute('AppliedCharacterStyle', 'CharacterStyle/$ID/[No character style]');
const xmlEl = doc.xml('XML/BackingStory.xml').createElement('XMLElement');
xmlEl.setAttribute('Self', 'di2');
xmlEl.setAttribute('MarkupTag', 'XMLTag/Root');
csr.appendChild(xmlEl);
psr.appendChild(csr);
backing.appendChild(psr);

// 4. tags: keep only Root
const tags = doc.xml('XML/Tags.xml').documentElement!;
for (const t of children(tags, 'XMLTag')) if (attr(t, 'Name') !== 'Root') removeElement(t);
if (!children(tags, 'XMLTag').length) {
  const root = doc.xml('XML/Tags.xml').createElement('XMLTag');
  root.setAttribute('Self', 'XMLTag/Root');
  root.setAttribute('Name', 'Root');
  tags.appendChild(root);
}
// mapping: empty
const mapping = doc.hasPart('XML/Mapping.xml') ? doc.xml('XML/Mapping.xml').documentElement! : undefined;
if (mapping) for (const m of children(mapping)) removeElement(m);

// 5. styles: keep built-ins ($ID/...) only; drop groups
const styles = doc.resource('Styles');
for (const group of children(styles)) {
  for (const c of children(group)) {
    if (c.tagName.endsWith('Group')) removeElement(c);
    else if (!(attr(c, 'Name') ?? '').startsWith('$ID/')) removeElement(c);
  }
}
// 6. swatches: keep None/Paper/Black/Registration + the default process colors
const graphic = doc.resource('Graphic');
const keepSwatch = (el: Element) => {
  const name = attr(el, 'Name') ?? '';
  return (
    ['None', 'Paper', 'Black', 'Registration'].includes(name) ||
    /^C=\d+ M=\d+ Y=\d+ K=\d+$/.test(name) ||
    attr(el, 'ColorRemovable') === 'false'
  );
};
const keptSwatches = new Set<string>();
for (const c of children(graphic)) {
  if (['Color', 'Gradient', 'MixedInk', 'Tint', 'Swatch'].includes(c.tagName)) {
    if (keepSwatch(c)) keptSwatches.add(attr(c, 'Self')!);
    else removeElement(c);
  }
}
for (const g of children(doc.root, 'ColorGroup')) {
  for (const s of children(g, 'ColorGroupSwatch'))
    if (!keptSwatches.has(attr(s, 'SwatchItemRef') ?? '')) removeElement(s);
}
// fix references to removed swatches in defaults/styles
for (const part of [
  'Resources/Styles.xml',
  'Resources/Preferences.xml',
  ...doc.masterSpreadParts(),
  ...doc.spreadParts(),
]) {
  for (const el of Array.from(doc.xml(part).getElementsByTagName('*')) as Element[]) {
    for (const a of ['FillColor', 'StrokeColor', 'GapColor']) {
      const v = el.getAttribute(a);
      if (
        v &&
        (v.startsWith('Color/') || v.startsWith('Gradient/') || v.startsWith('MixedInk/')) &&
        !keptSwatches.has(v)
      )
        el.setAttribute(a, a === 'FillColor' && el.tagName !== 'Rectangle' ? 'Color/Black' : 'Swatch/None');
    }
  }
}
// 7. fonts: keep only families used by built-in styles/defaults (Minion Pro) to stay small
const fonts = doc.resource('Fonts');
const usedFonts = new Set<string>();
for (const part of ['Resources/Styles.xml', 'Resources/Preferences.xml']) {
  for (const el of Array.from(doc.xml(part).getElementsByTagName('AppliedFont')))
    usedFonts.add(el.textContent?.trim() ?? '');
}
for (const fam of children(fonts, 'FontFamily'))
  if (!usedFonts.has(attr(fam, 'Name') ?? '')) removeElement(fam);
for (const c of children(fonts))
  if (c.tagName === 'CompositeFont' || c.tagName === 'CompositeFontEntry') removeElement(c);

// 8. document metadata: name and layer
doc.root.setAttribute('Name', 'Untitled.indd');
for (const layer of children(doc.root, 'Layer')) layer.setAttribute('Name', 'Layer 1');
// drop document users / watermark etc? keep — harmless.
// XMP metadata: replace by a minimal packet
doc.addBinaryPart(
  'META-INF/metadata.xml',
  new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 6.0">\n   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n      <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="application/x-indesign"/>\n   </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>`,
  ),
);

writeFileSync(out, doc.toBytes());
console.log(`wrote ${out} (${doc.toBytes().length} bytes) from ${source}`);
