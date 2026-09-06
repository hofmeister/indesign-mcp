import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'design-from-brief',
    {
      title: 'Design a document from a brief',
      description: 'Create a flyer, poster, brochure or other InDesign document from a short brief.',
      argsSchema: z.object({
        brief: z.string().describe('What the document is for, its content and tone.'),
        format: z
          .string()
          .optional()
          .describe('Page size / kind, e.g. "A4 flyer", "A5 brochure, 4 pages", "Instagram post".'),
        file: z.string().optional().describe('File name to save as (default: derived from the brief).'),
      }),
    },
    ({ brief, format, file }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Design an InDesign document for me.

Brief: ${brief}
Format: ${format ?? 'A4 portrait, one page'}
Save as: ${file ?? 'a sensible file name'}

Work like an InDesign layout designer:
1. Check list reference_documents; if a reference fits, start from it (new_document_from_reference) or import its styles/swatches.
2. Otherwise new_document with proper margins and bleed. Create a small set of paragraph styles (headline, subhead, body, caption) and 2–3 swatches before placing text.
3. Lay out text frames on a grid, give every item a name, use generate_image for pictures where the brief needs them (ask me before generating more than two).
4. Run validate_document at the end and tell me where the file is, which fonts you used and what I should check in InDesign.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'match-reference-look',
    {
      title: 'Recreate the look of a reference',
      description:
        'Build a new document that follows the styles, colors and masters of a reference document.',
      argsSchema: z.object({
        reference: z.string().describe('Reference document name.'),
        content: z.string().describe('The content for the new document.'),
        file: z.string().optional(),
      }),
    },
    ({ reference, content, file }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Create a new InDesign document${file ? ` saved as ${file}` : ''} that looks like the reference "${reference}".
Start with describe_reference to learn its page size, styles, swatches and master pages, then new_document_from_reference (empty pages, same setup). Lay out this content using the reference's paragraph styles and colors, adding pages as needed:

${content}

Finish with validate_document and a short summary of what you built.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'review-layout',
    {
      title: 'Review a layout',
      description: 'Inspect a document page by page and suggest improvements.',
      argsSchema: z.object({ document: z.string().describe('Path to the .idml file.') }),
    },
    ({ document }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Review the InDesign document at ${document}. Use describe_document and preview (if available) for every page, then give me concrete feedback as a senior layout designer would: hierarchy, alignment to the margins/grid, spacing consistency, typography (styles, sizes, leading), color use, image resolution (list images), and anything InDesign would flag (validate_document). Offer to apply the fixes.`,
          },
        },
      ],
    }),
  );
}
