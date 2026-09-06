// The batch tool: many edits, one call, one write.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/server.ts';

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

function docPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'indesign-mcp-batch-')), `${name}.idml`);
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return r as {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: { failed?: number; steps?: { ok: boolean; tool: string }[] };
  };
}

describe('batch', () => {
  test('runs a whole page of edits in one call', async () => {
    const client = await connectedClient();
    const document = docPath('page');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });

    const steps = [
      { tool: 'create_paragraph_style', arguments: { document, name: 'Title', size: 30, leading: 34 } },
      { tool: 'create_swatch', arguments: { document, name: 'Brand', color: 'cmyk(80,20,40,0)' } },
      {
        tool: 'add_text_frame',
        arguments: {
          document,
          page: 1,
          name: 'Headline',
          x: 20,
          y: 20,
          width: 160,
          height: 30,
          text: 'Summer sale',
          paragraphStyle: 'Title',
        },
      },
      {
        tool: 'add_rectangle',
        arguments: { document, page: 1, x: 20, y: 60, width: 160, height: 80, fill: 'Brand' },
      },
    ];

    const r = await call(client, 'batch', { steps });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.failed).toBe(0);
    expect(r.structuredContent?.steps).toHaveLength(4);

    // Everything really landed in the file.
    const items = await call(client, 'list_items', { document, page: 1 });
    expect(items.content[0]?.text ?? '').toContain('Headline');
    const styles = await call(client, 'list_styles', { document, kind: 'paragraph' });
    expect(styles.content[0]?.text ?? '').toContain('Title');
  });

  test('the document is written once, not once per step', async () => {
    const client = await connectedClient();
    const document = docPath('writes');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    const before = statSync(document).mtimeMs;
    await Bun.sleep(12);

    await call(client, 'batch', {
      steps: Array.from({ length: 6 }, (_, i) => ({
        tool: 'add_rectangle',
        arguments: { document, page: 1, x: 10, y: 10 + i * 20, width: 40, height: 10 },
      })),
    });

    expect(statSync(document).mtimeMs).toBeGreaterThan(before);
    const items = await call(client, 'list_items', { document, page: 1 });
    expect((items.content[0]?.text ?? '').split('\n')).toHaveLength(6);
  });

  test('stops at the first failure and keeps what came before', async () => {
    const client = await connectedClient();
    const document = docPath('fail');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });

    const r = await call(client, 'batch', {
      steps: [
        { tool: 'add_rectangle', arguments: { document, page: 1, x: 10, y: 10, width: 40, height: 10 } },
        { tool: 'add_rectangle', arguments: { document, page: 1, x: 10, y: 40, width: 0, height: 10 } },
        { tool: 'add_rectangle', arguments: { document, page: 1, x: 10, y: 70, width: 40, height: 10 } },
      ],
    });
    expect(r.structuredContent?.failed).toBe(1);
    expect(r.content[0]?.text ?? '').toContain('not run');

    // The first rectangle survived; the third never ran.
    const items = await call(client, 'list_items', { document, page: 1 });
    expect((items.content[0]?.text ?? '').split('\n')).toHaveLength(1);
  });

  test('continueOnError runs the rest', async () => {
    const client = await connectedClient();
    const document = docPath('continue');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });

    const r = await call(client, 'batch', {
      continueOnError: true,
      steps: [
        { tool: 'add_rectangle', arguments: { document, page: 1, x: 10, y: 10, width: 0, height: 10 } },
        { tool: 'add_rectangle', arguments: { document, page: 1, x: 10, y: 40, width: 40, height: 10 } },
      ],
    });
    expect(r.structuredContent?.failed).toBe(1);
    const items = await call(client, 'list_items', { document, page: 1 });
    expect((items.content[0]?.text ?? '').split('\n')).toHaveLength(1);
  });

  test('names a tool that does not exist, and refuses read-only ones', async () => {
    const client = await connectedClient();
    const document = docPath('bad');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });

    const missing = await call(client, 'batch', {
      steps: [{ tool: 'add_widget', arguments: {} }],
    });
    expect(missing.content[0]?.text ?? '').toContain('no tool called "add_widget"');

    const readOnly = await call(client, 'batch', {
      steps: [{ tool: 'list_items', arguments: { document } }],
    });
    expect(readOnly.content[0]?.text ?? '').toContain('only reads the document');
  });

  test('a step with bad arguments says which argument', async () => {
    const client = await connectedClient();
    const document = docPath('args');
    await call(client, 'new_document', { path: document, pageSize: 'A4' });
    const r = await call(client, 'batch', {
      steps: [{ tool: 'create_paragraph_style', arguments: { document, name: 'X', leading: 99999 } }],
    });
    expect(r.content[0]?.text ?? '').toMatch(/leading/);
  });

  test('a document created inside a batch is usable by later steps', async () => {
    const client = await connectedClient();
    const document = docPath('created');
    const r = await call(client, 'batch', {
      steps: [
        { tool: 'new_document', arguments: { path: document, pageSize: 'A5' } },
        {
          tool: 'add_text_frame',
          arguments: { document, page: 1, name: 'T', x: 10, y: 10, width: 80, height: 20, text: 'Hi' },
        },
      ],
    });
    expect(r.structuredContent?.failed).toBe(0);
    const items = await call(client, 'list_items', { document, page: 1 });
    expect(items.content[0]?.text ?? '').toContain('T');
  });
});
