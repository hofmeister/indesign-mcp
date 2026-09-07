// Parity with the real Adobe InDesign, when it is installed. These are the checks that would have
// caught the phantom-blank-page bug: the MCP's own model of a document agreed with itself, but the
// file on disk opened in InDesign with N-1 blank pages in front of the real ones.
//
// Skipped entirely when InDesign is not on this computer, so CI stays green without it.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { IdmlDocument } from '../src/idml/document.ts';
import { detectInDesign, exportWithInDesign, renderWithInDesign } from '../src/preview/indesign.ts';
import { createServer } from '../src/server.ts';

const installed = Boolean(detectInDesign());
const describeInDesign = installed ? describe : describe.skip;

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { text?: string }[];
  };
  if (r.isError) throw new Error(`${name}: ${r.content.map((c) => c.text).join('')}`);
  return r;
}

const outDir = () => mkdtempSync(join(tmpdir(), 'indesign-mcp-parity-'));

describeInDesign('InDesign sees the same document we do', () => {
  test('a multi-page document opens with exactly the pages we put in it', async () => {
    const client = await connectedClient();
    const document = join(outDir(), 'pages.idml');
    await call(client, 'new_document', { path: document, pageSize: 'A5', pages: 3 });
    // One frame on page 1 only: page 1 is where it must land, not page 3.
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      text: 'MCP PAGE ONE',
      x: 20,
      y: 20,
      width: 100,
      height: 40,
    });
    const r = await renderWithInDesign(document, [1, 2, 3], { dpi: 36 });
    expect(r.report?.documentPages).toBe(3);
    expect(r.report?.spreads).toBe(3);
    expect(r.report?.pages.map((p) => p.items)).toEqual([1, 0, 0]);
  }, 180_000);

  test('adding pages incrementally leaves no blanks in front either', async () => {
    const client = await connectedClient();
    const document = join(outDir(), 'incremental.idml');
    await call(client, 'new_document', { path: document, pageSize: 'A5', pages: 1 });
    await call(client, 'edit_pages', { document, op: 'add', count: 2 });
    await call(client, 'add_text_frame', {
      document,
      page: 1,
      text: 'PAGE ONE',
      x: 20,
      y: 20,
      width: 100,
      height: 40,
    });
    const r = await renderWithInDesign(document, [1, 2, 3], { dpi: 36 });
    expect(r.report?.documentPages).toBe(3);
    expect(r.report?.pages.map((p) => p.items)).toEqual([1, 0, 0]);
  }, 180_000);

  test('a document already broken on disk is healed by the next edit', async () => {
    const client = await connectedClient();
    const document = join(outDir(), 'broken.idml');
    await call(client, 'new_document', { path: document, pageSize: 'A5', pages: 3 });
    // Reproduce what earlier versions wrote: the real page count in PagesPerDocument.
    const broken = IdmlDocument.load(document);
    broken
      .resource('Preferences')
      .getElementsByTagName('DocumentPreference')[0]!
      .setAttribute('PagesPerDocument', '3');
    broken.save(document);
    expect((await renderWithInDesign(document, [1], { dpi: 36 })).report?.documentPages).toBe(5);

    await call(client, 'add_text_frame', {
      document,
      page: 1,
      text: 'PAGE ONE',
      x: 20,
      y: 20,
      width: 100,
      height: 40,
    });
    const r = await renderWithInDesign(document, [1, 2, 3], { dpi: 36 });
    expect(r.report?.documentPages).toBe(3);
    expect(r.report?.pages.map((p) => p.items)).toEqual([1, 0, 0]);
  }, 300_000);

  test('a PNG export reports every file InDesign wrote, and nothing else', async () => {
    const client = await connectedClient();
    const dir = outDir();
    const document = join(dir, 'export.idml');
    await call(client, 'new_document', { path: document, pageSize: 'A5', pages: 3 });
    const target = join(dir, 'out.png');
    const many = await exportWithInDesign(document, target, 'png', { pages: '1,2,3', dpi: 36 });
    expect(many.files.map((f) => f.replace(`${dir}/`, ''))).toEqual(['out.png', 'out2.png', 'out3.png']);
    // A later single-page export into the same folder must not claim the leftovers.
    const one = await exportWithInDesign(document, target, 'png', { pages: '1', dpi: 36 });
    expect(one.files.map((f) => f.replace(`${dir}/`, ''))).toEqual(['out.png']);
  }, 300_000);
});

test.skipIf(installed)('InDesign parity tests skipped: InDesign is not installed', () => {
  expect(installed).toBe(false);
});
