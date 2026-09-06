#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { log } from './log.ts';
import { createServer } from './server.ts';
import { runDoctor, runSetup } from './setup.ts';
import { VERSION } from './version.ts';

const USAGE = `indesign-mcp ${VERSION} — Adobe InDesign (IDML) tools for Claude

Usage:
  indesign-mcp                 Start the MCP server on stdio (this is what Claude runs)
  indesign-mcp setup           Register the server with Claude Desktop and/or Claude Code
      --openai-key KEY           OpenAI API key for image generation (optional)
      --documents DIR            Folder for new documents (default ~/Documents/InDesign MCP)
      --references DIR           Folder with your own reference .idml files (optional)
      --claude-desktop           Only configure Claude Desktop
      --claude-code              Only configure Claude Code
      --print                    Show the configuration instead of writing it
  indesign-mcp doctor          Check the installation: fonts, InDesign, OpenAI key, a test document
  indesign-mcp --version       Print the version
  indesign-mcp --help          Show this help
`;

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined: {
      const server = createServer();
      await server.connect(new StdioServerTransport());
      log.info(`indesign-mcp ${VERSION} running on stdio`);
      return;
    }
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    case '--help':
    case '-h':
    case 'help':
      console.log(USAGE);
      return;
    case 'setup':
      await runSetup(rest);
      return;
    case 'doctor':
      await runDoctor();
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
