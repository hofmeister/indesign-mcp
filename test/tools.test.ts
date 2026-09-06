import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';

let client: Client;
let dir: string;

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; data: Record<string, unknown> | undefined; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
  return {
    text,
    data: result.structuredContent as Record<string, unknown> | undefined,
    isError: Boolean(result.isError),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-'));
  const config = loadConfig({ INDESIGN_MCP_DOCUMENTS: dir, INDESIGN_MCP_DEFAULT_UNIT: 'mm' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
});

describe('tools end to end', () => {
  test('exposes the InDesign tool set', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      'new_document',
      'describe_document',
      'add_text_frame',
      'add_rectangle',
      'set_text',
      'create_paragraph_style',
      'create_swatch',
      'add_pages',
      'validate_document',
    ]) {
      expect(names).toContain(expected);
    }
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(20);
  });

  test('builds a small flyer', async () => {
    const created = await call('new_document', {
      path: 'flyer',
      pageSize: 'A5',
      pages: 2,
      margins: '10mm',
      bleed: '3mm',
    });
    expect(created.isError).toBe(false);
    expect(created.text).toContain('flyer.idml');
    const path = created.data!.path as string;

    let r = await call('create_swatch', { document: path, name: 'Brand Orange', cmyk: [0, 60, 100, 0] });
    expect(r.isError).toBe(false);
    r = await call('create_paragraph_style', {
      document: path,
      name: 'Headline',
      font: 'Minion Pro',
      fontStyle: 'Bold',
      size: 28,
      leading: 32,
      alignment: 'center',
      color: 'Brand Orange',
    });
    expect(r.isError).toBe(false);
    r = await call('add_text_frame', {
      document: path,
      page: 1,
      x: 10,
      y: 20,
      width: 128,
      height: 40,
      text: 'Summer **Sale**',
      paragraphStyle: 'Headline',
      name: 'Headline',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Headline');
    r = await call('add_rectangle', {
      document: path,
      page: 1,
      x: 10,
      y: 70,
      width: 128,
      height: 100,
      fill: 'Brand Orange',
      name: 'Band',
    });
    expect(r.isError).toBe(false);
    r = await call('add_text_frame', {
      document: path,
      page: 2,
      x: '10mm',
      y: '10mm',
      width: '128mm',
      height: '150mm',
      text: 'Body text\nMore text',
      name: 'Body',
      columns: 2,
    });
    expect(r.isError).toBe(false);
    r = await call('format_text', {
      document: path,
      find: 'More',
      item: 'Body',
      bold: true,
      color: 'Brand Orange',
    });
    expect(r.data?.count).toBe(1);
    r = await call('find_and_replace', { document: path, find: 'Body text', replace: 'Intro' });
    expect(r.data?.count).toBe(1);
    r = await call('move_item', { document: path, item: 'Band', y: 80 });
    expect(r.isError).toBe(false);
    r = await call('duplicate_item', { document: path, item: 'Band', toPage: 2, name: 'Band 2' });
    expect(r.isError).toBe(false);
    r = await call('add_pages', { document: path, count: 1 });
    expect(r.data?.total).toBe(3);

    const desc = await call('describe_document', { document: path });
    expect(desc.isError).toBe(false);
    expect(desc.text).toContain('Page 1');
    expect(desc.text).toContain('"Headline"');
    expect(desc.text).toContain('Summer Sale');
    expect(desc.text).toContain('Brand Orange');
    const page2 = (desc.data!.pages as { number: number; items: { name?: string }[] }[]).find(
      (p) => p.number === 2,
    )!;
    expect(page2.items.map((i) => i.name)).toEqual(expect.arrayContaining(['Body', 'Band 2']));

    const val = await call('validate_document', { document: path });
    expect(val.data?.errors).toBe(0);

    const text = await call('get_text', { document: path, item: 'Body' });
    expect(text.text).toContain('Intro');
  });

  test('gives helpful errors', async () => {
    const r = await call('describe_document', { document: 'does-not-exist.idml' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('File not found');
    const created = await call('new_document', { path: 'err-test' });
    const r2 = await call('move_item', {
      document: created.data!.path as string,
      item: 'Nothing',
      x: 1,
      y: 1,
    });
    expect(r2.isError).toBe(true);
    expect(r2.text).toContain('No item');
    const r3 = await call('add_text_frame', {
      document: created.data!.path as string,
      x: 1,
      y: 1,
      width: 10,
      height: 10,
      fill: 'Not A Color',
    });
    expect(r3.isError).toBe(true);
    expect(r3.text).toContain('Unknown swatch');
  });
});

describe('guides', () => {
  test('add_guides creates schema-valid Guide elements', async () => {
    const created = await call('new_document', { path: 'guides', pageSize: 'A4', columns: 3 });
    const doc = created.data!.path as string;
    const r = await call('add_guides', {
      document: doc,
      page: 1,
      horizontal: [50, 100],
      fromMargins: true,
      fromColumns: true,
    });
    expect(r.isError).toBe(false);
    expect(r.data!.count as number).toBeGreaterThanOrEqual(6);
    const v = await call('validate_document', { document: doc });
    expect(v.data!.errors).toBe(0);
  });
});
