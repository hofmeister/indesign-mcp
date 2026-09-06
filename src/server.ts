import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { type Config, loadConfig } from './config.ts';
import { OpenAIImageProvider } from './images/openai.ts';
import type { ImageProvider } from './images/provider.ts';
import { registerPrompts } from './prompts.ts';
import { ReferenceCatalog } from './references/catalog.ts';
import { ToolContext } from './tools/context.ts';
import { registerDocumentTools } from './tools/document.ts';
import { registerImageTools } from './tools/images.ts';
import { registerItemTools } from './tools/items.ts';
import { registerPageOpsTools, registerPageTools } from './tools/pages.ts';
import { registerPreviewTools } from './tools/preview.ts';
import { registerProductionTools } from './tools/production.ts';
import { registerReferenceTools } from './tools/references.ts';
import { registerShapeTools } from './tools/shapes.ts';
import { registerObjectStyleTools, registerStyleTools } from './tools/styles.ts';
import { registerTableTools } from './tools/tables.ts';
import { registerTextTools } from './tools/text.ts';
import { registerTypographyTools, registerVariableTools } from './tools/typography.ts';
import { VERSION } from './version.ts';

export const SERVER_INSTRUCTIONS = `This server creates and edits Adobe InDesign documents in IDML format (InDesign opens .idml files directly via File > Open).

How to work:
1. Start with new_document (or open_document for an existing file), then describe_document to see pages, items (with names and ids), styles and swatches.
2. Build the layout with InDesign vocabulary: pages and master pages, text frames, rectangles/ellipses/lines, images, paragraph and character styles, swatches, layers.
3. Positions are measured from the top-left corner of the page in millimetres unless another unit is given ("10mm", "0.5in", "12pt"). Give items names ("Headline", "Hero image") so you can edit them later.
4. Every edit is saved to the .idml file immediately. Run validate_document when you are done, and tell the user where the file is.
5. Fonts are not embedded: prefer fonts the user has installed, and mention which fonts you used.
6. References: list_reference_documents shows InDesign documents you can learn from; prefer new_document_from_reference or import_styles_from_reference over inventing styles from scratch.
7. Previews: call preview_page after visible changes and look at the image before reporting back; it saves a PNG next to the document too.
8. Pictures: place_image links existing files; generate_image / edit_image create pictures with OpenAI (costs money, confirm before generating many) and save them in a Links folder next to the document.
9. Finishing a job: run preflight_document before handing anything over and fix what it reports; package_document collects the document with its pictures for a printer or client; export_document makes a PDF, PNG or JPEG.
10. Repetitive documents (badges, certificates, price lists): put <<Field>> placeholders on one page and use data_merge with a CSV or JSON file instead of building each page by hand.`;

export interface ServerDeps {
  imageProvider?: ImageProvider;
}

export function createServer(config: Config = loadConfig(), deps: ServerDeps = {}): McpServer {
  const server = new McpServer(
    { name: 'indesign-mcp', version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const ctx = new ToolContext(config);
  const imageProvider = deps.imageProvider ?? new OpenAIImageProvider(config.openaiApiKey, config.imageModel);

  server.registerTool(
    'server_info',
    {
      title: 'Server info',
      description: 'Returns the version of the InDesign MCP server, its default unit and folders.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        version: z.string(),
        runtime: z.string(),
        unit: z.string(),
        documentsDir: z.string(),
        imageGeneration: z.boolean(),
      }),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const output = {
        version: VERSION,
        runtime: `bun ${typeof Bun !== 'undefined' ? Bun.version : 'unknown'}`,
        unit: config.unit,
        documentsDir: config.documentsDir,
        imageGeneration: Boolean(config.openaiApiKey),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  registerDocumentTools(server, ctx);
  registerPageTools(server, ctx);
  registerItemTools(server, ctx);
  registerTextTools(server, ctx);
  registerStyleTools(server, ctx);
  registerObjectStyleTools(server, ctx);
  registerShapeTools(server, ctx);
  registerPageOpsTools(server, ctx);
  registerTableTools(server, ctx);
  registerTypographyTools(server, ctx);
  registerVariableTools(server, ctx);
  registerImageTools(server, ctx, imageProvider);
  const catalog = new ReferenceCatalog(config.referenceDirs.filter((d) => existsSync(d)));
  registerReferenceTools(server, ctx, catalog);
  registerPreviewTools(server, ctx);
  registerProductionTools(server, ctx);
  registerPrompts(server);
  return server;
}
