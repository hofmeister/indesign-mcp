import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IdmlDocument } from '../src/idml/document.ts';
import { createTextFrame } from '../src/idml/items.ts';
import {
  availableSchemaSets,
  loadGrammar,
  pickSchemaSet,
  validateAgainstSchema,
} from '../src/idml/schema.ts';
import { createDocument } from '../src/idml/template.ts';
import { parseXml } from '../src/idml/xml.ts';
import { parseGrammar } from '../src/rng/parse.ts';
import { validateElement } from '../src/rng/validate.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'idml');
const SCHEMAS = join(import.meta.dir, '..', 'schemas', 'idml');

function grammarFrom(rng: string) {
  return parseGrammar(rng, 'test.rng', () => {
    throw new Error('no includes');
  });
}

function check(rng: string, xml: string) {
  const g = grammarFrom(rng);
  return validateElement(g, parseXml(xml).documentElement!);
}

describe('RELAX NG engine', () => {
  const addressBook = `<grammar xmlns="http://relaxng.org/ns/structure/1.0" datatypeLibrary="http://www.w3.org/2001/XMLSchema-datatypes">
  <start><ref name="book"/></start>
  <define name="book"><element name="addressBook"><zeroOrMore><ref name="card"/></zeroOrMore></element></define>
  <define name="card"><element name="card">
    <attribute name="id"><data type="int"><param name="minInclusive">1</param></data></attribute>
    <optional><attribute name="kind"><choice><value>home</value><value>work</value></choice></attribute></optional>
    <interleave>
      <element name="name"><text/></element>
      <optional><element name="email"><text/></element></optional>
    </interleave>
    <optional><element name="tags"><list><zeroOrMore><data type="token"/></zeroOrMore></list></element></optional>
  </element></define>
</grammar>`;

  test('accepts valid documents', () => {
    expect(
      check(
        addressBook,
        `<addressBook><card id="1" kind="home"><email>a@b.c</email><name>John</name></card><card id="2"><name>Jane</name><tags>a b c</tags></card></addressBook>`,
      ),
    ).toEqual([]);
    expect(check(addressBook, '<addressBook/>')).toEqual([]);
  });

  test('reports missing, unknown and invalid attributes and elements', () => {
    const errs = check(
      addressBook,
      `<addressBook><card kind="other" foo="1"><name>x</name><phone/></card><card id="0"><name>y</name></card><card id="3"/></addressBook>`,
    );
    const messages = errs.map((e) => e.message).join('\n');
    expect(messages).toContain('kind="other" has an invalid value');
    expect(messages).toContain('Attribute foo is not allowed');
    expect(messages).toContain('missing a required attribute: id');
    expect(messages).toContain('Element <phone> is not allowed');
    expect(messages).toContain('id="0" has an invalid value');
    expect(messages).toContain('<card> is incomplete');
    expect(errs[0]!.path).toBe('/addressBook/card');
  });

  test('handles text, values and whitespace', () => {
    const rng = `<element name="a" xmlns="http://relaxng.org/ns/structure/1.0" datatypeLibrary="http://www.w3.org/2001/XMLSchema-datatypes"><choice><group><attribute name="type"><value>unit</value></attribute><data type="double"/></group><group><attribute name="type"><value>enumeration</value></attribute><value>Auto</value></group></choice></element>`;
    expect(check(rng, '<a type="unit">13.5</a>')).toEqual([]);
    expect(check(rng, '<a type="enumeration">Auto</a>')).toEqual([]);
    expect(check(rng, '<a type="enumeration"> Auto </a>')).toEqual([]);
    expect(check(rng, '<a type="enumeration">Manual</a>').length).toBe(1);
    expect(check(rng, '<a type="unit">abc</a>').length).toBe(1);
  });
});

describe('IDML schemas', () => {
  test('bundled schema sets are available and parse', () => {
    const sets = availableSchemaSets();
    expect(sets.map((s) => s.version)).toContain('15.0');
    const set = pickSchemaSet(sets, '15.1')!;
    expect(set.version).toBe('15.0');
    const t0 = performance.now();
    const g = loadGrammar(set, 'Spreads/Spread.rng');
    expect(g.start).toBeDefined();
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  test('a real InDesign 2020 export validates against the 15.0 schema', () => {
    const doc = IdmlDocument.load(join(FIXTURES, 'interview.idml'));
    const t0 = performance.now();
    const r = validateAgainstSchema(doc);
    const ms = performance.now() - t0;
    expect(r.partsChecked).toBeGreaterThan(10);
    expect(r.issues.filter((i) => i.level === 'error').map((i) => `${i.part}: ${i.message}`)).toEqual([]);
    // InDesign 2020 15.1 added attributes the 15.0 schema does not know; they are informational
    expect(r.issues.filter((i) => i.level === 'info').every((i) => /is not allowed/.test(i.message))).toBe(
      true,
    );
    expect(r.versionNote).toContain('15.0');
    expect(ms).toBeLessThan(20000);
  });

  test('older exports validate against their own schema version (folder)', () => {
    const doc = IdmlDocument.load(join(FIXTURES, '4-pages.idml'));
    const r = validateAgainstSchema(doc, { schemaDir: SCHEMAS });
    expect(r.schemaVersion).toBe('7.5');
    expect(r.issues.map((i) => `${i.part}: ${i.message}`)).toEqual([]);
  });

  test.each(readdirSync(FIXTURES).filter((f) => f.endsWith('.idml')))('%s has no schema errors', (file) => {
    const doc = IdmlDocument.load(join(FIXTURES, file));
    const r = validateAgainstSchema(doc, { schemaDir: SCHEMAS });
    expect(
      r.issues.filter((i) => i.level === 'error').map((i) => `${i.part} ${i.path}: ${i.message}`),
    ).toEqual([]);
  });

  test('documents we generate validate too, and mistakes are caught', () => {
    const doc = createDocument({ pageSize: 'A4', pages: 2 });
    const el = createTextFrame(
      doc,
      { page: 1 },
      { rect: { x: 10, y: 10, width: 100, height: 50 }, text: 'Hello **bold**' },
    );
    const again = IdmlDocument.fromBytes(doc.toBytes());
    const r = validateAgainstSchema(again);
    expect(
      r.issues.filter((i) => i.level === 'error').map((i) => `${i.part} ${i.path}: ${i.message}`),
    ).toEqual([]);
    el.setAttribute('Bogus', '1');
    el.setAttribute('Visible', 'maybe');
    const r2 = validateAgainstSchema(IdmlDocument.fromBytes(doc.toBytes()));
    const msgs = r2.issues.map((i) => i.message).join('\n');
    expect(msgs).toContain('Attribute Bogus is not allowed');
    expect(msgs).toContain('Visible="maybe" has an invalid value');
  });
});
