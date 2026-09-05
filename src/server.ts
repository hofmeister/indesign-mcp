import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { VERSION } from './version.ts';

export const SERVER_INSTRUCTIONS = `You are working with Adobe InDesign documents in IDML format through this server.
Workflow: open or create a document, call describe_document to learn what is on each page, make edits using
InDesign vocabulary (pages, master pages, text frames, paragraph styles, swatches), then preview_page to show the
result. Measurements default to millimetres unless the user says otherwise. Every edit is saved to the .idml file
immediately.`;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'indesign-mcp', version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'server_info',
    {
      title: 'Server info',
      description: 'Returns the version of the InDesign MCP server and its capabilities.',
      inputSchema: z.object({}),
      outputSchema: z.object({ version: z.string(), runtime: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const output = {
        version: VERSION,
        runtime: `bun ${typeof Bun !== 'undefined' ? Bun.version : 'unknown'}`,
      };
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    },
  );

  return server;
}
