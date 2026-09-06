// Data merge: fill a template page with rows from a CSV or JSON file, the way InDesign's
// Data Merge panel does. Placeholders are written <<Field>> in text, or as a frame name for images.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { IdmlDocument } from './document.ts';
import { type FitMode, fillFrameWithImage } from './images.ts';
import { isPageItem, itemSpreadBounds } from './items.ts';
import { duplicatePage } from './pageops.ts';
import { findPage, listPages, type PageInfo, pageForSpreadRect } from './pages.ts';
import { readStoryPlainText } from './stories.ts';
import { attr, children, type Element } from './xml.ts';

export type MergeRecord = Record<string, string>;

export interface MergeData {
  fields: string[];
  /** Fields whose values are image file paths (CSV header starting with @). */
  imageFields: string[];
  records: MergeRecord[];
}

const PLACEHOLDER = /<<\s*([^<>]+?)\s*>>/g;
const ONE_PLACEHOLDER = /<<\s*([^<>]+?)\s*>>/;
const IMAGE_EXT = /\.(png|jpe?g|tiff?|gif|webp|psd|pdf|ai|eps|bmp)$/i;

/** Splits CSV text into rows. Handles quotes, embedded newlines and , ; or tab separators. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/)[0] ?? '';
  const counts = [
    [',', (firstLine.match(/,/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
  ] as [string, number][];
  counts.sort((a, b) => b[1] - a[1]);
  const sep = counts[0]![1] > 0 ? counts[0]![0] : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Reads a .csv, .tsv or .json data source. JSON must be an array of objects. */
export function readDataSource(path: string): MergeData {
  if (!existsSync(path)) throw new Error(`Data file not found: ${path}`);
  const text = readFileSync(path, 'utf8');
  if (/^\s*[[{]/.test(text)) return fromJson(text, path);
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(`${path} has no data rows (a header row plus at least one record)`);
  const header = rows[0]!.map((h) => h.trim());
  const fields = header.map((h) => h.replace(/^@/, ''));
  const imageFields = header.filter((h) => h.startsWith('@')).map((h) => h.slice(1));
  const records = rows.slice(1).map((r) => {
    const rec: MergeRecord = {};
    fields.forEach((f, i) => {
      rec[f] = (r[i] ?? '').trim();
    });
    return rec;
  });
  return { fields, imageFields, records };
}

function fromJson(text: string, path: string): MergeData {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  const rows = Array.isArray(data) ? data : (data as { records?: unknown[] }).records;
  if (!Array.isArray(rows)) throw new Error(`${path} must contain an array of records`);
  const fields: string[] = [];
  const records = rows.map((r) => {
    const rec: MergeRecord = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      const key = k.replace(/^@/, '');
      if (!fields.includes(key)) fields.push(key);
      rec[key] = v === null || v === undefined ? '' : String(v);
    }
    return rec;
  });
  const imageFields = fields.filter((f) => records.some((r) => IMAGE_EXT.test(r[f] ?? '')));
  return { fields, imageFields, records };
}

/** Every <<Field>> used in the document's text and in frame names. */
export function listMergeFields(doc: IdmlDocument): { text: string[]; images: string[] } {
  const text = new Set<string>();
  const images = new Set<string>();
  for (const part of doc.storyParts()) {
    const story = children(doc.xml(part).documentElement, 'Story')[0];
    if (!story) continue;
    for (const m of readStoryPlainText(story).matchAll(PLACEHOLDER)) text.add(m[1]!.trim());
  }
  for (const spread of doc.spreads()) {
    const visit = (el: Element) => {
      if (!isPageItem(el)) return;
      const name = attr(el, 'Name');
      if (name) for (const m of name.matchAll(PLACEHOLDER)) images.add(m[1]!.trim());
      if (el.tagName === 'Group') for (const c of children(el)) visit(c);
    };
    for (const el of children(spread)) visit(el);
  }
  return { text: [...text], images: [...images] };
}

function lookup(record: MergeRecord, field: string): string | undefined {
  if (field in record) return record[field];
  const key = Object.keys(record).find((k) => k.toLowerCase() === field.toLowerCase());
  return key === undefined ? undefined : record[key];
}

/** Replaces <<Field>> in a story's text runs. Returns the fields that had no value. */
export function substituteInStory(story: Element, record: MergeRecord): string[] {
  const missing: string[] = [];
  for (const content of Array.from(story.getElementsByTagName('Content')) as Element[]) {
    const text = content.textContent ?? '';
    if (!text.includes('<<')) continue;
    const replaced = text.replace(PLACEHOLDER, (_all, field: string) => {
      const value = lookup(record, field.trim());
      if (value === undefined) {
        missing.push(field.trim());
        return '';
      }
      return value;
    });
    if (replaced === text) continue;
    while (content.firstChild) content.removeChild(content.firstChild);
    if (replaced) content.appendChild(content.ownerDocument!.createTextNode(replaced));
  }
  return missing;
}

function itemsOnPage(doc: IdmlDocument, page: PageInfo, pages: PageInfo[]): Element[] {
  const spread = doc.findBySelf(page.spreadId)?.element;
  if (!spread) return [];
  const out: Element[] = [];
  const visit = (el: Element, forced: boolean) => {
    if (!isPageItem(el)) return;
    let onPage = forced;
    if (!onPage) {
      const b = itemSpreadBounds(el);
      onPage = b ? pageForSpreadRect(pages, page.spreadId, b)?.index === page.index : false;
    }
    if (onPage) out.push(el);
    if (el.tagName === 'Group') for (const c of children(el)) visit(c, onPage);
  };
  for (const el of children(spread)) visit(el, false);
  return out;
}

export interface MergeOptions {
  /** Page holding the placeholders (default 1). */
  templatePage?: number | string;
  /** Base folder for relative image paths (default: next to the data file). */
  imageBase?: string;
  fit?: FitMode;
  /** Stop after this many records. */
  limit?: number;
}

export interface MergeResult {
  records: number;
  pages: number[];
  imagesPlaced: number;
  missingFields: string[];
  missingImages: string[];
}

/** Fills the template page once per record, adding a page for every record after the first. */
export function mergeRecords(doc: IdmlDocument, data: MergeData, options: MergeOptions = {}): MergeResult {
  const records = options.limit ? data.records.slice(0, options.limit) : data.records;
  if (!records.length) throw new Error('The data source has no records');
  const template = findPage(doc, options.templatePage ?? 1);
  const missingFields = new Set<string>();
  const missingImages: string[] = [];
  const pagesOut: number[] = [];
  let imagesPlaced = 0;

  const fill = (pageIndex: number, record: MergeRecord) => {
    const pages = listPages(doc);
    const page = pages.find((p) => p.index === pageIndex);
    if (!page) return;
    for (const el of itemsOnPage(doc, page, pages)) {
      if (el.tagName === 'TextFrame') {
        const story = doc.story(attr(el, 'ParentStory') ?? '');
        if (story) for (const f of substituteInStory(story, record)) missingFields.add(f);
      }
      const name = attr(el, 'Name');
      const nameField = name ? ONE_PLACEHOLDER.exec(name) : null;
      if (nameField) {
        const field = nameField[1]?.trim();
        const value = field ? lookup(record, field) : undefined;
        if (!value) {
          if (field) missingImages.push(field);
        } else {
          const path = isAbsolute(value) ? value : resolve(options.imageBase ?? process.cwd(), value);
          if (!existsSync(path)) missingImages.push(value);
          else {
            fillFrameWithImage(doc, el, { path, fit: options.fit ?? 'fill' });
            imagesPlaced++;
          }
        }
      }
    }
    pagesOut.push(pageIndex);
  };

  // Duplicate first so every copy still holds the placeholders, then fill from the back.
  const copies: number[] = [template.index];
  for (let i = 1; i < records.length; i++) {
    const copy = duplicatePage(doc, template.index, listPages(doc).length);
    copies.push(copy.index);
  }
  copies.forEach((pageIndex, i) => {
    fill(pageIndex, records[i]!);
  });

  return {
    records: records.length,
    pages: pagesOut,
    imagesPlaced,
    missingFields: [...missingFields],
    missingImages: [...new Set(missingImages)],
  };
}

/** Fills the template once per record into separate documents. Returns the written paths. */
export function mergeToDocuments(
  doc: IdmlDocument,
  data: MergeData,
  outDir: string,
  nameFor: (record: MergeRecord, index: number) => string,
  options: MergeOptions = {},
): { paths: string[]; result: MergeResult } {
  const records = options.limit ? data.records.slice(0, options.limit) : data.records;
  const bytes = doc.toBytes();
  const paths: string[] = [];
  const merged: MergeResult = {
    records: 0,
    pages: [],
    imagesPlaced: 0,
    missingFields: [],
    missingImages: [],
  };
  records.forEach((record, i) => {
    const copy = IdmlDocument.fromBytes(bytes, doc.path);
    const r = mergeRecords(copy, { ...data, records: [record] }, options);
    const path = resolve(outDir, `${nameFor(record, i)}.idml`);
    copy.save(path);
    paths.push(path);
    merged.records++;
    merged.imagesPlaced += r.imagesPlaced;
    merged.missingFields = [...new Set([...merged.missingFields, ...r.missingFields])];
    merged.missingImages = [...new Set([...merged.missingImages, ...r.missingImages])];
  });
  return { paths, result: merged };
}
