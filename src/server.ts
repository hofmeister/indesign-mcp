import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { type Config, loadConfig } from './config.ts';
import { OpenAIImageProvider } from './images/openai.ts';
import type { ImageProvider } from './images/provider.ts';
import { registerPrompts } from './prompts.ts';
import { ReferenceCatalog } from './references/catalog.ts';
import { registerBatchTool } from './tools/batch.ts';
import { ToolContext } from './tools/context.ts';
import { registerDocumentTools } from './tools/document.ts';
import { registerMergedTools } from './tools/families.ts';
import { registerImageTools } from './tools/images.ts';
import { registerItemTools } from './tools/items.ts';
import { registerPageOpsTools, registerPageTools } from './tools/pages.ts';
import { registerPreviewTools } from './tools/preview.ts';
import { registerProductionTools } from './tools/production.ts';
import { registerReferenceTools } from './tools/references.ts';
import { ToolRegistry } from './tools/registry.ts';
import { registerShapeTools } from './tools/shapes.ts';
import { registerObjectStyleTools, registerStyleTools } from './tools/styles.ts';
import { registerTableTools } from './tools/tables.ts';
import { registerTextTools } from './tools/text.ts';
import { registerTypographyTools, registerVariableTools } from './tools/typography.ts';
import { VERSION } from './version.ts';

export const SERVER_INSTRUCTIONS = `This server creates and edits Adobe InDesign documents in IDML format (InDesign opens .idml files directly via File > Open).

How to work:
1. Start with new_document (or open_document for an existing file), then describe_document to see pages, items (with names and ids), styles and swatches. The list tool shows one subject in full (items, styles, swatches, fonts, layers, pages...).
1b. Several tools take an operation rather than being one tool each: add_shape (rectangle, ellipse, line, polygon, path), edit_item (move, resize, rotate, delete, duplicate, rename, arrange, layer, align, fit), edit_pages, edit_layers, preview and list.
1c. Do the work in as few calls as possible — a long build runs out of turns otherwise. create_swatch, create_paragraph_style, create_character_style and create_object_style each take a list ("swatches"/"styles"), so the whole palette and type scale is one call apiece, not one per style. For anything else, put the steps in one batch call: it runs them in order and writes the file once. Build a page that way rather than a call per frame.
2. Build the layout with InDesign vocabulary: pages and master pages, text frames, rectangles/ellipses/lines, images, paragraph and character styles, swatches, layers.
2b. Masters: anything that repeats across pages — running head, footer, folio, background rule, logo, the text-frame grid — belongs on a master page, never copied onto each page. Place it with target master ("A-Master") instead of page, use insert_page_number on the master for real page numbers, create_master for a second layout ("B-Chapter") and apply_master to choose which pages get it; override_master_item only where a single page must differ. Build the master before the pages.
2c. Layers: create a few named layers up front with edit_layers (op "create") — typically "Background", "Images", "Text" — and pass layer: on every item you add. A document with everything on "Layer 1" is hard to edit afterwards, which is the point of building it in InDesign at all.
3. Positions are measured from the top-left corner of the page in millimetres unless another unit is given ("10mm", "0.5in", "12pt"); width and height are sizes, not coordinates. Give items names ("Headline", "Hero image") so you can edit them later. Tools refuse impossible input (a frame with no width, a line with two identical ends, margins that leave no room) and add a "Note:" when something lands on the pasteboard or hangs over the trim — read those notes and fix the placement unless the user wanted a bleed.
4. Every edit is saved to the .idml file immediately. Run validate_document when you are done, and tell the user where the file is.
5. Fonts are not embedded: prefer fonts the user has installed, and mention which fonts you used.
6. References: list reference_documents shows InDesign documents you can learn from; prefer new_document_from_reference or import_styles_from_reference over inventing styles from scratch.
7. Previews: call preview after visible changes and look at the image before reporting back; it saves a PNG next to the document too.
8. Pictures: place_image links existing files; generate_image / edit_image create pictures with OpenAI (costs money, confirm before generating many) and save them in a Links folder next to the document.
9. Finishing a job: run preflight_document before handing anything over and fix what it reports — it flags items repeated on several pages that belong on a master, and a document still on a single layer, as well as the print problems; package_document collects the document with its pictures for a printer or client; export_document makes a PDF, PNG or JPEG.
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
      inputSchema: z.strictObject({}),
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

  const reg = new ToolRegistry(server);
  registerDocumentTools(reg, ctx);
  registerPageTools(reg, ctx);
  registerItemTools(reg, ctx);
  registerTextTools(reg, ctx);
  registerStyleTools(reg, ctx);
  registerObjectStyleTools(reg, ctx);
  registerShapeTools(reg, ctx);
  registerPageOpsTools(reg, ctx);
  registerTableTools(reg, ctx);
  registerTypographyTools(reg, ctx);
  registerVariableTools(reg, ctx);
  registerImageTools(reg, ctx, imageProvider);
  const catalog = new ReferenceCatalog(config.referenceDirs.filter((d) => existsSync(d)));
  registerReferenceTools(reg, ctx, catalog);
  registerPreviewTools(reg, ctx);
  registerProductionTools(reg, ctx);
  registerMergedTools(reg);
  registerBatchTool(reg, ctx);
  registerPrompts(server);
  return server;
}
