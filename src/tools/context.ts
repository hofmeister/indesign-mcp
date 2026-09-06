// Shared state for tools: config, the open-document cache and path resolution.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { expandHome } from '../config.ts';
import { IdmlDocument } from '../idml/document.ts';
import type { Rect } from '../idml/geometry.ts';
import { type LengthInput, toPoints, type Unit } from '../idml/units.ts';

interface CacheEntry {
  doc: IdmlDocument;
  mtimeMs: number;
  size: number;
}

export class ToolContext {
  readonly config: Config;
  private cache = new Map<string, CacheEntry>();
  /** Set while a batch is running: paths whose document still needs writing. */
  private deferred: Map<string, IdmlDocument> | undefined;

  constructor(config: Config) {
    this.config = config;
  }

  get unit(): Unit {
    return this.config.unit;
  }

  /** Points from a user length; bare numbers use the configured default unit. */
  pt(value: LengthInput): number {
    return toPoints(value, this.unit);
  }

  ptOpt(value: LengthInput | undefined): number | undefined {
    return value === undefined ? undefined : this.pt(value);
  }

  rect(r: { x: LengthInput; y: LengthInput; width: LengthInput; height: LengthInput }): Rect {
    return { x: this.pt(r.x), y: this.pt(r.y), width: this.pt(r.width), height: this.pt(r.height) };
  }

  /** Absolute path for a document reference. Bare names resolve inside the documents folder. */
  resolvePath(p: string, { mustExist = false, forWrite = false } = {}): string {
    let path = expandHome(p.trim());
    if (!isAbsolute(path)) path = resolve(this.config.documentsDir, path);
    if (forWrite && extname(path).toLowerCase() !== '.idml') path = `${path}.idml`;
    if (mustExist && !existsSync(path)) {
      throw new Error(
        `File not found: ${path}${isAbsolute(p) ? '' : ` (bare names are looked up in ${this.config.documentsDir})`}`,
      );
    }
    if (forWrite) mkdirSync(dirname(path), { recursive: true });
    return path;
  }

  /** Loads (or returns the cached) document. The cache is invalidated when the file changes on disk. */
  open(p: string): IdmlDocument {
    const path = this.resolvePath(p, { mustExist: true });
    const st = statSync(path);
    const cached = this.cache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.doc;
    const doc = IdmlDocument.load(path);
    this.cache.set(path, { doc, mtimeMs: st.mtimeMs, size: st.size });
    return doc;
  }

  /** Saves the document to its path and refreshes the cache entry. */
  save(doc: IdmlDocument, path = doc.path): string {
    if (!path) throw new Error('Document has no path');
    if (this.deferred) {
      // Inside a batch: remember what to write and carry on. Every tool still behaves as if it had
      // saved, and the file is written once when the batch ends.
      this.deferred.set(path, doc);
      return path;
    }
    doc.save(path);
    const st = statSync(path);
    this.cache.set(path, { doc, mtimeMs: st.mtimeMs, size: st.size });
    return path;
  }

  /** Holds writes until `flushSaves`, so a run of edits costs one write instead of one each. */
  deferSaves(): void {
    this.deferred ??= new Map();
  }

  /** Writes everything held back since `deferSaves`. Safe to call when nothing was deferred. */
  flushSaves(): void {
    const pending = this.deferred;
    this.deferred = undefined;
    if (!pending) return;
    for (const [path, doc] of pending) this.save(doc, path);
  }

  /**
   * Registers a freshly created document under a path and writes it.
   *
   * This one always writes, even inside a batch: a later step in the same batch opens the document
   * by path, and it has to be there.
   */
  adopt(doc: IdmlDocument, path: string): string {
    this.deferred?.delete(path);
    doc.save(path);
    const st = statSync(path);
    this.cache.set(path, { doc, mtimeMs: st.mtimeMs, size: st.size });
    return path;
  }

  forget(path: string): void {
    this.cache.delete(path);
  }

  displayName(path: string): string {
    return basename(path);
  }

  /** Folder for images that belong to a document: <folder>/Links */
  linksDir(docPath: string): string {
    const dir = join(dirname(docPath), 'Links');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
