// Reference documents: bundled files (embedded in the binary) plus folders the user configures.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { BUNDLED_REFERENCES } from '../generated/references.ts';
import { IdmlDocument } from '../idml/document.ts';
import { type DocumentSummary, summarizeDocument } from '../idml/inspect.ts';
import type { Unit } from '../idml/units.ts';

export interface ReferenceEntry {
  name: string;
  source: 'bundled' | 'folder';
  /** Readable path (for bundled files this is the embedded asset path). */
  path: string;
  folder?: string;
}

export class ReferenceCatalog {
  private folders: string[] = [];
  private summaries = new Map<string, DocumentSummary>();

  constructor(folders: string[] = []) {
    for (const f of folders) this.addFolder(f);
  }

  addFolder(folder: string): { added: boolean; count: number } {
    const abs = resolve(folder);
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      throw new Error(`Reference folder not found: ${abs}`);
    const added = !this.folders.includes(abs);
    if (added) this.folders.push(abs);
    return { added, count: this.scanFolder(abs).length };
  }

  listFolders(): string[] {
    return [...this.folders];
  }

  private scanFolder(folder: string): ReferenceEntry[] {
    try {
      return readdirSync(folder)
        .filter((f) => extname(f).toLowerCase() === '.idml')
        .sort()
        .map((f) => ({
          name: basename(f, extname(f)),
          source: 'folder' as const,
          path: join(folder, f),
          folder,
        }));
    } catch {
      return [];
    }
  }

  list(): ReferenceEntry[] {
    const out: ReferenceEntry[] = BUNDLED_REFERENCES.map((r) => ({
      name: r.name,
      source: 'bundled' as const,
      path: r.path,
    }));
    for (const folder of this.folders) out.push(...this.scanFolder(folder));
    return out;
  }

  /** Finds a reference by name (case-insensitive, with or without .idml) or by path. */
  find(ref: string): ReferenceEntry {
    const all = this.list();
    const lower = ref.toLowerCase().replace(/\.idml$/, '');
    const hit =
      all.find((r) => r.name.toLowerCase() === lower) ??
      all.find((r) => r.path === ref) ??
      all.find((r) => r.name.toLowerCase().includes(lower));
    if (hit) return hit;
    if (existsSync(ref) && extname(ref).toLowerCase() === '.idml')
      return { name: basename(ref, '.idml'), source: 'folder', path: resolve(ref) };
    throw new Error(
      `Reference "${ref}" not found. Available: ${all.map((r) => r.name).join(', ') || 'none'}`,
    );
  }

  bytes(entry: ReferenceEntry): Uint8Array {
    return new Uint8Array(readFileSync(entry.path));
  }

  load(ref: string): { entry: ReferenceEntry; doc: IdmlDocument } {
    const entry = this.find(ref);
    return {
      entry,
      doc: IdmlDocument.fromBytes(this.bytes(entry), entry.source === 'folder' ? entry.path : undefined),
    };
  }

  summary(ref: string, unit: Unit): { entry: ReferenceEntry; summary: DocumentSummary } {
    const entry = this.find(ref);
    const key = `${entry.path}|${unit}`;
    let s = this.summaries.get(key);
    if (!s) {
      s = summarizeDocument(IdmlDocument.fromBytes(this.bytes(entry)), unit);
      s.path = entry.source === 'bundled' ? `${entry.name} (bundled)` : entry.path;
      this.summaries.set(key, s);
    }
    return { entry, summary: s };
  }
}
