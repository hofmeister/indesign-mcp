// Validates IDML parts against Adobe's RELAX NG schemas (schemas/idml/<version>/...).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BUNDLED_SCHEMAS } from '../generated/schemas.ts';
import { type Grammar, parseGrammar } from '../rng/parse.ts';
import { type RngError, validateElement } from '../rng/validate.ts';
import type { IdmlDocument } from './document.ts';

export interface SchemaSet {
  version: string;
  /** part path pattern -> schema file (relative within the version folder) */
  files: Map<string, string>;
  source: 'bundled' | 'folder';
  read: (file: string) => string;
}

export interface SchemaIssue {
  /** "error" = the schema rejects it; "info" = unknown attribute/element on a document newer than the schema. */
  level: 'error' | 'info';
  part: string;
  message: string;
  path: string;
  line?: number;
}

const grammarCache = new Map<string, Grammar>();

function schemaFileFor(part: string): string | undefined {
  if (part === 'designmap.xml') return 'designmap.rng';
  if (part.startsWith('Spreads/')) return 'Spreads/Spread.rng';
  if (part.startsWith('MasterSpreads/')) return 'MasterSpreads/MasterSpread.rng';
  if (part.startsWith('Stories/')) return 'Stories/Story.rng';
  if (part.startsWith('Resources/') || part.startsWith('XML/')) return part.replace(/\.xml$/, '.rng');
  return undefined;
}

/** Bundled schema sets (embedded) plus an optional folder of extra versions. */
export function availableSchemaSets(extraDir?: string): SchemaSet[] {
  const sets: SchemaSet[] = [];
  const byVersion = new Map<string, Map<string, string>>();
  for (const s of BUNDLED_SCHEMAS) {
    const m = byVersion.get(s.version) ?? new Map<string, string>();
    byVersion.set(s.version, m);
    m.set(s.file, s.path);
  }
  for (const [version, files] of byVersion) {
    sets.push({ version, files, source: 'bundled', read: (file) => readFileSync(files.get(file)!, 'utf8') });
  }
  if (extraDir && existsSync(extraDir)) {
    for (const version of readdirSync(extraDir)) {
      const dir = join(extraDir, version);
      if (!/^\d+(\.\d+)?$/.test(version) || !existsSync(join(dir, 'designmap.rng'))) continue;
      const files = new Map<string, string>();
      const walk = (d: string, prefix: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (require('node:fs').statSync(p).isDirectory()) walk(p, `${prefix}${f}/`);
          else if (f.endsWith('.rng')) files.set(`${prefix}${f}`, p);
        }
      };
      walk(dir, '');
      const idx = sets.findIndex((s) => s.version === version);
      const set: SchemaSet = {
        version,
        files,
        source: 'folder',
        read: (file) => readFileSync(files.get(file)!, 'utf8'),
      };
      if (idx >= 0) sets[idx] = set;
      else sets.push(set);
    }
  }
  return sets.sort((a, b) => Number(a.version) - Number(b.version));
}

/** The schema set whose version is the highest one not above the document's DOMVersion. */
export function pickSchemaSet(sets: SchemaSet[], domVersion: string): SchemaSet | undefined {
  const v = Number(domVersion) || 0;
  const candidates = sets.filter((s) => Number(s.version) <= v + 1e-9);
  return candidates.at(-1) ?? sets[0];
}

export function loadGrammar(set: SchemaSet, file: string): Grammar {
  const key = `${set.source}|${set.version}|${file}`;
  let g = grammarCache.get(key);
  if (!g) {
    const text = set.read(file);
    g = parseGrammar(text, file, (href, fromUrl) => {
      // resolve relative to the schema file inside the version folder
      const base = fromUrl.includes('/') ? fromUrl.slice(0, fromUrl.lastIndexOf('/') + 1) : '';
      const parts = `${base}${href}`.split('/');
      const out: string[] = [];
      for (const p of parts) {
        if (p === '..') out.pop();
        else if (p !== '.') out.push(p);
      }
      const rel = out.join('/');
      if (!set.files.has(rel))
        throw new Error(`Included schema ${rel} not found in schema set ${set.version}`);
      return set.read(rel);
    });
    grammarCache.set(key, g);
  }
  return g;
}

export interface SchemaValidationResult {
  schemaVersion: string;
  documentVersion: string;
  versionNote?: string;
  issues: SchemaIssue[];
  partsChecked: number;
}

/**
 * Validates every XML part of the document against the closest schema set.
 * Attribute-value errors about DOMVersion are suppressed when the document is newer than the schema.
 */
export function validateAgainstSchema(
  doc: IdmlDocument,
  options: { schemaDir?: string; maxErrorsPerPart?: number; parts?: string[] } = {},
): SchemaValidationResult {
  const sets = availableSchemaSets(options.schemaDir);
  if (!sets.length) throw new Error('No IDML schemas available');
  const set = pickSchemaSet(sets, doc.domVersion)!;
  const newer = Number(doc.domVersion) > Number(set.version) + 1e-9;
  // The document is older than every available schema: the check is approximate, so nothing is an error.
  const older = Number(doc.domVersion) < Number(set.version) - 1e-9;
  const issues: SchemaIssue[] = [];
  let partsChecked = 0;
  for (const part of doc.partNames()) {
    if (!part.endsWith('.xml') || part.startsWith('META-INF/')) continue;
    if (options.parts && !options.parts.includes(part)) continue;
    const file = schemaFileFor(part);
    if (!file || !set.files.has(file)) continue;
    const grammar = loadGrammar(set, file);
    const root = doc.xml(part).documentElement;
    if (!root) continue;
    partsChecked++;
    // A newer document declares a DOMVersion the older schema does not know; check it as the schema's version.
    const originalVersion = root.getAttribute('DOMVersion');
    if ((newer || older) && originalVersion) root.setAttribute('DOMVersion', set.version);
    let errors: RngError[];
    try {
      errors = validateElement(grammar, root, { maxErrors: options.maxErrorsPerPart ?? 25 });
    } finally {
      if ((newer || older) && originalVersion) root.setAttribute('DOMVersion', originalVersion);
    }
    for (const e of errors) {
      const unknownThing = /is not allowed (on|here)/.test(e.message);
      issues.push({
        level: older || (newer && unknownThing) ? 'info' : 'error',
        part,
        message: e.message,
        path: e.path,
        line: e.line,
      });
    }
  }
  return {
    schemaVersion: set.version,
    documentVersion: doc.domVersion,
    versionNote: newer
      ? `The document is IDML ${doc.domVersion} but the newest bundled schema is ${set.version}; attributes introduced after ${set.version} are reported as unknown. Add a newer schema (see schemas/idml/README.md) for exact results.`
      : undefined,
    issues,
    partsChecked,
  };
}

/** Resolves a validator path such as /Styles/RootObjectStyleGroup/ObjectStyle[2] to an element. */
function elementAtPath(
  root: import('./xml.ts').Element,
  path: string,
): import('./xml.ts').Element | undefined {
  const segments = path.split('/').filter(Boolean);
  if (!segments.length) return undefined;
  let el: import('./xml.ts').Element | undefined = root;
  for (let i = 1; i < segments.length && el; i++) {
    const m = /^([^[]+)(?:\[(\d+)\])?$/.exec(segments[i]!);
    if (!m) return undefined;
    const name = m[1]!;
    const idx = m[2] ? Number(m[2]) : 1;
    let n = 0;
    let next: import('./xml.ts').Element | undefined;
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (
        c.nodeType === 1 &&
        ((c as import('./xml.ts').Element).localName ?? (c as import('./xml.ts').Element).tagName) === name
      ) {
        n++;
        if (n === idx) {
          next = c as import('./xml.ts').Element;
          break;
        }
      }
    }
    el = next;
  }
  return el;
}

export interface PruneReport {
  attributesRemoved: number;
  elementsRemoved: number;
  details: string[];
}

/**
 * Removes attributes and elements the document's own schema version rejects (typically things
 * copied in from a newer InDesign version). Does nothing when the document is newer than the
 * newest available schema, because then the schema cannot tell new features from mistakes.
 */
export function pruneUnknownForSchema(
  doc: IdmlDocument,
  options: { schemaDir?: string; parts?: string[] } = {},
): PruneReport {
  const report: PruneReport = { attributesRemoved: 0, elementsRemoved: 0, details: [] };
  const sets = availableSchemaSets(options.schemaDir);
  const set = pickSchemaSet(sets, doc.domVersion);
  // Prune only with an authoritative schema: same version as the document.
  if (!set || Math.abs(Number(doc.domVersion) - Number(set.version)) > 0.05 + 1e-9) return report;
  for (let round = 0; round < 4; round++) {
    const r = validateAgainstSchema(doc, {
      schemaDir: options.schemaDir,
      parts: options.parts,
      maxErrorsPerPart: 200,
    });
    let changed = false;
    for (const issue of r.issues) {
      const root = doc.xml(issue.part).documentElement;
      if (!root) continue;
      let m = /^Attribute (\S+) is not allowed on <([^>]+)>/.exec(issue.message);
      if (m) {
        const el = elementAtPath(root, issue.path);
        if (el?.hasAttribute(m[1]!)) {
          el.removeAttribute(m[1]!);
          report.attributesRemoved++;
          report.details.push(`${issue.part}: removed ${m[2]}@${m[1]} (unknown in IDML ${set.version})`);
          changed = true;
        }
        continue;
      }
      m = /^Element <([^>]+)> is not allowed here/.exec(issue.message);
      if (m) {
        const el = elementAtPath(root, issue.path);
        if (el?.parentNode && el !== root) {
          el.parentNode.removeChild(el);
          report.elementsRemoved++;
          report.details.push(`${issue.part}: removed <${m[1]}> (unknown in IDML ${set.version})`);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return report;
}

export { dirname, resolve };
