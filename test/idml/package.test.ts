import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdmlDocument } from '../../src/idml/document.ts';
import { checkContainer, IDML_MIMETYPE, readPackage, writePackage } from '../../src/idml/package.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'idml');
const fixtureFiles = readdirSync(FIXTURES).filter((f) => f.endsWith('.idml'));

describe('IDML package', () => {
  test('fixtures exist', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  test.each(fixtureFiles)('round-trips %s byte-for-byte per part', (file) => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, file)));
    expect(checkContainer(bytes)).toEqual([]);
    const parts = readPackage(bytes);
    const written = writePackage(parts);
    expect(checkContainer(written)).toEqual([]);
    const again = readPackage(written);
    expect([...again.keys()]).toEqual([...parts.keys()]);
    for (const [name, data] of parts) expect(again.get(name)).toEqual(data);
  });

  test('written package has mimetype first and stored', () => {
    const parts = new Map<string, Uint8Array>([
      ['designmap.xml', new TextEncoder().encode('<Document/>')],
      ['mimetype', new TextEncoder().encode(IDML_MIMETYPE)],
    ]);
    const bytes = writePackage(parts);
    expect(checkContainer(bytes)).toEqual([]);
    expect([...readPackage(bytes).keys()][0]).toBe('mimetype');
  });

  test('detects a package with the mimetype in the wrong place', () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, fixtureFiles[0]!)));
    const parts = readPackage(bytes);
    // Build a zip where mimetype is compressed and not first, bypassing writePackage.
    const { zipSync } = require('fflate') as typeof import('fflate');
    const bad = zipSync({ 'designmap.xml': parts.get('designmap.xml')!, mimetype: parts.get('mimetype')! });
    expect(checkContainer(bad).length).toBeGreaterThan(0);
  });
});

describe('IdmlDocument', () => {
  test.each(fixtureFiles)('loads, re-serializes and re-loads %s', (file) => {
    const doc = IdmlDocument.load(join(FIXTURES, file));
    expect(doc.domVersion).toMatch(/^\d+\.\d+$/);
    expect(doc.spreads().length).toBeGreaterThan(0);
    // touch every XML part so it goes through parse + serialize
    for (const name of doc.partNames()) if (name.endsWith('.xml')) doc.xml(name);
    const again = IdmlDocument.fromBytes(doc.toBytes());
    expect(again.partNames().sort()).toEqual(doc.partNames().sort());
    expect(again.spreads().length).toBe(doc.spreads().length);
    expect(again.storyParts()).toEqual(doc.storyParts());
    // the serialized designmap still starts with the declaration and the aid processing instruction
    const text = new TextDecoder().decode(again.parts.get('designmap.xml')!);
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true);
    expect(text).toContain('<?aid ');
  });

  test('generates ids that do not collide', () => {
    const doc = IdmlDocument.load(join(FIXTURES, 'interview.idml'));
    const a = doc.newId();
    const b = doc.newId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^u[0-9a-z]+$/);
    expect(doc.findBySelf(a)).toBeUndefined();
    expect(doc.findBySelf('u165')?.element.tagName).toBe('Spread');
  });
});
