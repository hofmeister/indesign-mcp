#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { log } from './log.ts';
import { createServer } from './server.ts';
import { VERSION } from './version.ts';

const USAGE = `indesign-mcp ${VERSION}

Usage:
  indesign-mcp            Start the MCP server on stdio (what Claude runs)
  indesign-mcp --version  Print the version
  indesign-mcp --help     Show this help
`;

async function main(argv: string[]): Promise<void> {
  const [command] = argv;
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return;
  }
  if (command !== undefined) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log.info(`indesign-mcp ${VERSION} running on stdio`);
}

main(process.argv.slice(2)).catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
