// Runs tool calls against the server, without reconnecting anything.
//
//   bun run scripts/call.ts '[{"tool":"new_document","arguments":{"path":"x.idml"}}]'
//   bun run scripts/call.ts calls.json
//   echo '[...]' | bun run scripts/call.ts
//   bun run scripts/call.ts --binary ~/.local/bin/indesign-mcp calls.json
//
// Without --binary the server runs from source, which is the fast loop while developing: no
// `bun run build`, no install. With --binary the same calls go to a compiled executable over
// stdio, which is how to check that what is installed behaves like the source.
//
// Text results are printed; images are written next to the calls as call-<n>.png so they can be
// looked at.
import { readFileSync, writeFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createServer } from '../src/server.ts';

interface Call {
  tool: string;
  arguments?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const binaryAt = argv.indexOf('--binary');
  const binary = binaryAt >= 0 ? argv[binaryAt + 1] : undefined;
  const arg = argv.filter((a, i) => i !== binaryAt && i !== binaryAt + 1)[0];
  const source = arg
    ? arg.trim().startsWith('[')
      ? arg
      : readFileSync(arg, 'utf8')
    : readFileSync(0, 'utf8');
  const calls = JSON.parse(source) as Call[] | Call;
  const list = Array.isArray(calls) ? calls : [calls];

  const client = new Client({ name: 'call', version: '0' });
  if (binary) {
    await client.connect(new StdioClientTransport({ command: binary, args: [] }));
    console.log(`(calls go to ${binary})`);
  } else {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }

  for (const [i, call] of list.entries()) {
    const result = (await client.callTool({
      name: call.tool,
      arguments: call.arguments ?? {},
    })) as {
      isError?: boolean;
      content: { type: string; text?: string; data?: string; mimeType?: string }[];
    };
    const mark = result.isError ? '✗' : '✓';
    console.log(`\n${mark} ${i + 1}. ${call.tool}`);
    for (const part of result.content) {
      if (part.type === 'text' && part.text) console.log(part.text);
      else if (part.data) {
        const file = `call-${i + 1}.${part.mimeType?.includes('png') ? 'png' : 'jpg'}`;
        writeFileSync(file, Buffer.from(part.data, 'base64'));
        console.log(`[image written to ${file}]`);
      }
    }
  }
  process.exit(0);
}

await main();
