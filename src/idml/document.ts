// The in-memory model of one IDML package: parts are parsed lazily into DOM documents and
// serialized back on save. Untouched parts are copied through byte for byte.
import { readFileSync, writeFileSync } from 'node:fs';
import { IdGenerator } from './ids.ts';
import { checkContainer, type PackageParts, readPackage, writePackage } from './package.ts';
import { allElements, attr, children, type Document, type Element, parseXml, serializeXml } from './xml.ts';

export const IDPKG_NS = 'http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging';

export type PartKind =
  | 'Spread'
  | 'MasterSpread'
  | 'Story'
  | 'Graphic'
  | 'Fonts'
  | 'Styles'
  | 'Preferences'
  | 'Tags'
  | 'BackingStory'
  | 'Mapping';

export interface PartRef {
  kind: PartKind;
  src: string;
}

export class IdmlDocument {
  readonly parts: PackageParts;
  private parsed = new Map<string, Document>();
  private removed = new Set<string>();
  readonly ids: IdGenerator;
  /** Where the document was loaded from / last saved to. */
  path: string | undefined;

  private constructor(parts: PackageParts, path?: string) {
    this.parts = parts;
    this.path = path;
    this.ids = new IdGenerator(this.collectIds());
  }

  static fromBytes(bytes: Uint8Array, path?: string): IdmlDocument {
    return new IdmlDocument(readPackage(bytes), path);
  }

  static load(path: string): IdmlDocument {
    const bytes = new Uint8Array(readFileSync(path));
    const problems = checkContainer(bytes);
    const doc = IdmlDocument.fromBytes(bytes, path);
    doc.containerProblems = problems;
    return doc;
  }

  /** Container-level problems found while loading (mimetype ordering etc.). */
  containerProblems: string[] = [];

  // ---- parts -------------------------------------------------------------------------------

  hasPart(name: string): boolean {
    return !this.removed.has(name) && (this.parsed.has(name) || this.parts.has(name));
  }

  partNames(): string[] {
    const names = new Set<string>();
    for (const n of this.parts.keys()) if (!this.removed.has(n)) names.add(n);
    for (const n of this.parsed.keys()) names.add(n);
    return [...names];
  }

  /** Parsed DOM of a part (cached; the same Document instance is returned on every call). */
  xml(name: string): Document {
    let doc = this.parsed.get(name);
    if (!doc) {
      const bytes = this.parts.get(name);
      if (!bytes || this.removed.has(name)) throw new Error(`IDML part not found: ${name}`);
      doc = parseXml(new TextDecoder().decode(bytes), name);
      this.parsed.set(name, doc);
    }
    return doc;
  }

  /** Registers a new XML part (e.g. a new Story or Spread file). */
  addXmlPart(name: string, doc: Document): void {
    this.removed.delete(name);
    this.parsed.set(name, doc);
  }

  /** Registers a binary part (rare in IDML, but allowed). */
  addBinaryPart(name: string, bytes: Uint8Array): void {
    this.removed.delete(name);
    this.parsed.delete(name);
    this.parts.set(name, bytes);
  }

  removePart(name: string): void {
    this.parsed.delete(name);
    this.removed.add(name);
  }

  // ---- designmap --------------------------------------------------------------------------

  get designmap(): Document {
    return this.xml('designmap.xml');
  }

  /** The <Document> root element of designmap.xml. */
  get root(): Element {
    return this.designmap.documentElement!;
  }

  get domVersion(): string {
    return attr(this.root, 'DOMVersion') ?? '';
  }

  /** idPkg:* references in designmap order. */
  partRefs(kind?: PartKind): PartRef[] {
    const refs: PartRef[] = [];
    for (const el of children(this.root)) {
      if (!el.tagName.startsWith('idPkg:')) continue;
      const k = el.tagName.slice(6) as PartKind;
      if (kind && k !== kind) continue;
      const src = attr(el, 'src');
      if (src) refs.push({ kind: k, src });
    }
    return refs;
  }

  spreadParts(): string[] {
    return this.partRefs('Spread').map((r) => r.src);
  }
  masterSpreadParts(): string[] {
    return this.partRefs('MasterSpread').map((r) => r.src);
  }
  storyParts(): string[] {
    return this.partRefs('Story').map((r) => r.src);
  }

  /** The <Spread> elements of all spreads, in document order. */
  spreads(): Element[] {
    return this.spreadParts()
      .map((p) => children(this.xml(p).documentElement, 'Spread')[0]!)
      .filter(Boolean);
  }

  masterSpreads(): Element[] {
    return this.masterSpreadParts()
      .map((p) => children(this.xml(p).documentElement, 'MasterSpread')[0]!)
      .filter(Boolean);
  }

  /** The <Story> element with the given Self id, or undefined. */
  story(id: string): Element | undefined {
    const part = `Stories/Story_${id}.xml`;
    if (this.hasPart(part)) {
      const s = children(this.xml(part).documentElement, 'Story')[0];
      if (s && attr(s, 'Self') === id) return s;
    }
    for (const p of this.storyParts()) {
      const s = children(this.xml(p).documentElement, 'Story')[0];
      if (s && attr(s, 'Self') === id) return s;
    }
    return undefined;
  }

  storyPartName(id: string): string | undefined {
    for (const p of this.storyParts()) {
      const s = children(this.xml(p).documentElement, 'Story')[0];
      if (s && attr(s, 'Self') === id) return p;
    }
    return undefined;
  }

  resource(kind: 'Graphic' | 'Fonts' | 'Styles' | 'Preferences'): Element {
    const ref = this.partRefs(kind)[0]?.src ?? `Resources/${kind}.xml`;
    return this.xml(ref).documentElement!;
  }

  // ---- ids --------------------------------------------------------------------------------

  private collectIds(): string[] {
    const ids: string[] = [];
    for (const name of this.parts.keys()) {
      if (!name.endsWith('.xml') || name.startsWith('META-INF/')) continue;
      const text = new TextDecoder().decode(this.parts.get(name)!);
      // Fast regex scan; parsing every part up front would be slow for large documents.
      for (const m of text.matchAll(/\sSelf="([^"]+)"/g)) ids.push(m[1]!);
    }
    return ids;
  }

  /** A fresh, unused id like "u1a3". */
  newId(): string {
    return this.ids.next();
  }

  /** Finds an element by its Self id in any parsed or unparsed part. Parses parts on demand. */
  findBySelf(id: string): { element: Element; part: string } | undefined {
    const needle = `Self="${id}"`;
    for (const name of this.partNames()) {
      if (!name.endsWith('.xml') || name.startsWith('META-INF/')) continue;
      const parsed = this.parsed.get(name);
      if (!parsed) {
        const text = new TextDecoder().decode(this.parts.get(name)!);
        if (!text.includes(needle)) continue;
      }
      for (const el of allElements(this.xml(name))) {
        if (attr(el, 'Self') === id) return { element: el, part: name };
      }
    }
    return undefined;
  }

  // ---- output -----------------------------------------------------------------------------

  toBytes(): Uint8Array {
    const out: PackageParts = new Map();
    // keep original order; new parts go to the end
    for (const [name, bytes] of this.parts) {
      if (this.removed.has(name)) continue;
      const parsed = this.parsed.get(name);
      out.set(name, parsed ? new TextEncoder().encode(serializeXml(parsed)) : bytes);
    }
    for (const [name, doc] of this.parsed) {
      if (!out.has(name) && !this.removed.has(name))
        out.set(name, new TextEncoder().encode(serializeXml(doc)));
    }
    return writePackage(out);
  }

  save(path = this.path): string {
    if (!path) throw new Error('No path to save the document to');
    writeFileSync(path, this.toBytes());
    this.path = path;
    return path;
  }

  /** Creates a new empty XML part document with the idPkg wrapper root used by IDML. */
  newPartDocument(kind: PartKind): Document {
    const doc = parseXml(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<idPkg:${kind} xmlns:idPkg="${IDPKG_NS}" DOMVersion="${this.domVersion}">\n</idPkg:${kind}>`,
      kind,
    );
    return doc;
  }
}
