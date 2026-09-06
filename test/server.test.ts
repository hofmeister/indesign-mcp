import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createServer } from '../src/server.ts';
import { VERSION } from '../src/version.ts';

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

describe('server', () => {
  test('lists tools and reports its version', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('server_info');
    const result = await client.callTool({ name: 'server_info', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { version: string }).version).toBe(VERSION);
  });
});
