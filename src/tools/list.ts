// One `list` tool instead of thirteen `list_*` ones. The handlers stay in the module that owns
// each subject; this only chooses between them.
import * as z from 'zod';
import type { ToolRegistry } from './registry.ts';
import { documentParam, fail, pageParam, run, toolInput } from './shared.ts';

export function registerListTool(reg: ToolRegistry): void {
  const listings = reg.listingsFor();
  const names = listings.map((l) => l.what);
  if (!names.length) return;

  reg.tool(
    'list',
    {
      title: 'List part of the document',
      description: `Lists one part of a document: ${names.join(', ')}. Start with describe_document for an overview; use this when you want one thing in full.`,
      inputSchema: toolInput({
        what: z.enum(names as [string, ...string[]]).describe('Which part of the document to list.'),
        document: documentParam
          .optional()
          .describe('Path to the .idml file. Not needed for "reference_documents", required otherwise.'),
        page: pageParam.optional().describe('Only for "items" and "images": limit to one page.'),
        kind: z
          .enum(['paragraph', 'character', 'object', 'all'])
          .optional()
          .describe('Only for "styles": which kind to list (default all).'),
        includeMasters: z.boolean().optional().describe('Only for "items": include items on master pages.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run(async () => {
        const listing = reg.listingFor(args.what);
        if (!listing) return fail(new Error(`Cannot list "${args.what}".`));

        const { what: _what, ...rest } = args;
        // Only pass on what this listing actually takes, so a stray `page` on a listing that has no
        // pages is refused rather than silently ignored.
        const given = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        const parsed = listing.schema
          ? listing.schema.safeParse(given)
          : { success: true as const, data: given };
        if (!parsed.success)
          return fail(
            new Error(
              `list ${args.what}: ${parsed.error.issues
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('; ')}`,
            ),
          );
        return await listing.run(parsed.data as never);
      }),
  );
}
