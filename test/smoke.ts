// Smoke test for a compiled binary: spawns it, speaks raw JSON-RPC over stdio and checks the basics.
//   bun run test/smoke.ts dist/indesign-mcp
import { spawn } from 'node:child_process';

const binary = process.argv[2];
if (!binary) {
  console.error('usage: bun run test/smoke.ts <path-to-binary>');
  process.exit(2);
}

const TIMEOUT_MS = 60_000;
const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => {
  stdout += d.toString();
});
child.stderr.on('data', (d) => {
  stderr += d.toString();
});

const pending = new Map<number, (msg: unknown) => void>();
let nextId = 1;
function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), TIMEOUT_MS);
  });
}
function notify(method: string, params: unknown): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}
let buffered = '';
child.stdout.on('data', (d) => {
  buffered += d.toString();
  let nl = buffered.indexOf('\n');
  while (nl >= 0) {
    const line = buffered.slice(0, nl).trim();
    buffered = buffered.slice(nl + 1);
    if (line) {
      let msg: { id?: number };
      try {
        msg = JSON.parse(line);
      } catch {
        console.error(`FAIL: non-JSON line on stdout: ${line.slice(0, 200)}`);
        process.exit(1);
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    }
    nl = buffered.indexOf('\n');
  }
});

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${message}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout.slice(0, 2000)}`);
    child.kill();
    process.exit(1);
  }
}

const init = (await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
})) as { result?: { serverInfo?: { name?: string; version?: string } } };
assert(init.result?.serverInfo?.name === 'indesign-mcp', 'initialize returned server name');
console.log(`initialized: ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}`);
notify('notifications/initialized', {});

const tools = (await request('tools/list', {})) as { result?: { tools?: { name: string }[] } };
const names = (tools.result?.tools ?? []).map((t) => t.name);
assert(names.includes('server_info'), `tools/list includes server_info (got ${names.join(', ')})`);
console.log(`tools: ${names.length}`);

const info = (await request('tools/call', { name: 'server_info', arguments: {} })) as {
  result?: { structuredContent?: { version?: string }; isError?: boolean };
};
assert(!info.result?.isError && info.result?.structuredContent?.version, 'server_info returns a version');
console.log(`server_info: ${JSON.stringify(info.result?.structuredContent)}`);

// Create a document through the binary: proves the embedded template and XML pipeline work when compiled.
const { mkdtempSync, existsSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-smoke-'));
const docPath = join(dir, 'smoke.idml');
const created = (await request('tools/call', {
  name: 'new_document',
  arguments: { path: docPath, pageSize: 'A4', pages: 2, margins: '15mm' },
})) as { result?: { isError?: boolean; content?: { text?: string }[] } };
assert(!created.result?.isError, `new_document succeeded: ${created.result?.content?.[0]?.text}`);
assert(existsSync(docPath), 'document file written');
const frame = (await request('tools/call', {
  name: 'add_text_frame',
  arguments: {
    document: docPath,
    page: 1,
    x: 20,
    y: 20,
    width: 100,
    height: 40,
    text: 'Smoke **test**',
    name: 'Title',
  },
})) as { result?: { isError?: boolean; content?: { text?: string }[] } };
assert(!frame.result?.isError, `add_text_frame succeeded: ${frame.result?.content?.[0]?.text}`);
const validated = (await request('tools/call', {
  name: 'validate_document',
  arguments: { document: docPath },
})) as {
  result?: { isError?: boolean; structuredContent?: { errors?: number } };
};
assert(
  !validated.result?.isError && validated.result?.structuredContent?.errors === 0,
  'validate_document reports 0 errors',
);
console.log(`document created and validated at ${docPath}`);

child.stdin.end();
const code: number | null = await new Promise((resolve) => child.on('exit', resolve));
assert(code === 0 || code === null, `clean exit after stdin closed (exit code ${code})`);
console.log('smoke test passed');
