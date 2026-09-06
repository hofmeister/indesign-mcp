import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { IdmlDocument } from '../idml/document.ts';
import { findItem } from '../idml/items.ts';
import { listPages } from '../idml/pages.ts';
import { resolveStyle } from '../idml/styles.ts';
import {
  anchorItem,
  applyListSettings,
  createHyperlink,
  expandSpecialCharacters,
  listHyperlinks,
  readTabStops,
  SPECIAL_CHARACTERS,
  setSection,
  setTabStops,
} from '../idml/typography.ts';
import { attr, type Element } from '../idml/xml.ts';
import type { ToolContext } from './context.ts';
import { documentParam, itemParam, lengthParam, ok, pageParam, run } from './shared.ts';

function storyOf(doc: IdmlDocument, item: string, page?: number | string): Element {
  const found = findItem(doc, item, page);
  if (found.element.tagName !== 'TextFrame')
    throw new Error(`"${item}" is a ${found.info.type}, not a text frame`);
  const story = doc.story(attr(found.element, 'ParentStory') ?? '');
  if (!story) throw new Error('That text frame has no story');
  return story;
}

export function registerTypographyTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'set_list_options',
    {
      title: 'Bullets and numbering',
      description:
        'Turns a paragraph style into a bulleted or numbered list (or switches the list off). Apply the style to paragraphs as usual; InDesign then draws the bullets or numbers.',
      inputSchema: z.object({
        document: documentParam,
        style: z.string().describe('Paragraph style to change.'),
        kind: z.enum(['none', 'bullet', 'number']),
        bulletCharacter: z.string().max(2).optional().describe('Default •. Try –, ▪, ●, ✓.'),
        numberStyle: z
          .enum(['arabic', 'upper-roman', 'lower-roman', 'upper-letters', 'lower-letters'])
          .optional(),
        numberFormat: z
          .string()
          .optional()
          .describe('Pattern, e.g. "^#." for 1. or "^#)" for 1). ^# is the number, ^t a tab.'),
        startAt: z.number().int().min(1).optional(),
        textAfter: z.string().optional().describe('What follows the bullet/number, default a tab (^t).'),
        indent: lengthParam.optional().describe('Left indent of the paragraph.'),
        bulletIndent: lengthParam.optional().describe('How far the bullet/number hangs into the margin.'),
        characterStyle: z.string().optional().describe('Character style for the bullet/number itself.'),
        font: z.string().optional().describe('Font for the bullet character.'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const style = resolveStyle(doc, 'ParagraphStyle', args.style);
        applyListSettings(doc, style, {
          kind: args.kind,
          bulletCharacter: args.bulletCharacter,
          numberStyle: args.numberStyle,
          numberFormat: args.numberFormat,
          startAt: args.startAt,
          textAfter: args.textAfter,
          indent: ctx.ptOpt(args.indent),
          bulletIndent: ctx.ptOpt(args.bulletIndent),
          characterStyle: args.characterStyle,
          font: args.font,
        });
        ctx.save(doc);
        return ok(
          args.kind === 'none'
            ? `"${args.style}" is no longer a list.`
            : `"${args.style}" is now a ${args.kind === 'bullet' ? `bulleted list (${args.bulletCharacter ?? '•'})` : `numbered list (${args.numberStyle ?? 'arabic'})`}.`,
        );
      }),
  );

  server.registerTool(
    'set_tab_stops',
    {
      title: 'Tab stops',
      description:
        'Sets the tab stops of a paragraph style — useful for price lists and tables of contents (a right tab with a dotted leader).',
      inputSchema: z.object({
        document: documentParam,
        style: z.string(),
        stops: z
          .array(
            z.object({
              position: lengthParam.describe('Distance from the left edge of the text frame.'),
              alignment: z.enum(['left', 'center', 'right', 'decimal']).optional(),
              leader: z.string().max(4).optional().describe('Fill character, e.g. "." for a dotted leader.'),
              alignOn: z
                .string()
                .max(1)
                .optional()
                .describe('Character to align on for decimal tabs (default ".").'),
            }),
          )
          .describe('An empty list removes all tab stops.'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const style = resolveStyle(doc, 'ParagraphStyle', args.style);
        setTabStops(
          style,
          args.stops.map((s) => ({
            position: ctx.pt(s.position),
            alignment: s.alignment,
            leader: s.leader,
            alignOn: s.alignOn,
          })),
        );
        ctx.save(doc);
        const stops = readTabStops(style);
        return ok(`"${args.style}" now has ${stops.length} tab stop(s).`, { stops });
      }),
  );

  server.registerTool(
    'add_hyperlink',
    {
      title: 'Add hyperlink',
      description:
        'Turns text into a hyperlink to a web address. The link survives PDF and EPUB export from InDesign.',
      inputSchema: z.object({
        document: documentParam,
        item: itemParam.describe('Text frame containing the text.'),
        page: pageParam.optional(),
        text: z.string().describe('The exact text to link.'),
        url: z.string().describe('Target address, e.g. https://example.com'),
        all: z.boolean().optional().describe('Link every occurrence (default: only the first).'),
        characterStyle: z
          .string()
          .optional()
          .describe('Character style for the link text, e.g. a blue underlined style.'),
        name: z.string().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const story = storyOf(doc, args.item, args.page);
        const links = createHyperlink(doc, story, args.text, args.url, {
          characterStyle: args.characterStyle,
          name: args.name,
          all: args.all,
        });
        ctx.save(doc);
        return ok(`Linked ${links.length} occurrence(s) of "${args.text}" to ${links[0]!.url}.`, { links });
      }),
  );

  server.registerTool(
    'list_hyperlinks',
    {
      title: 'List hyperlinks',
      description: 'Lists the hyperlinks in the document with their targets.',
      inputSchema: z.object({ document: documentParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(() => {
        const links = listHyperlinks(ctx.open(document));
        return ok(links.map((l) => `${l.name} → ${l.url}`).join('\n') || 'No hyperlinks', { links });
      }),
  );

  server.registerTool(
    'set_page_numbering',
    {
      title: 'Page numbering and sections',
      description:
        'Controls how pages are numbered: where a section starts, the first number, the style (1, i, I, a, A) and a section prefix. Combine with insert_page_number on a master page.',
      inputSchema: z.object({
        document: documentParam,
        startPage: z.number().int().min(1).optional().describe('Page where this section starts (default 1).'),
        pageNumberStart: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Number the first page of the section gets.'),
        continueNumbering: z.boolean().optional().describe('Continue from the previous section instead.'),
        style: z.enum(['arabic', 'upper-roman', 'lower-roman', 'upper-letters', 'lower-letters']).optional(),
        prefix: z.string().optional().describe('Section prefix, e.g. "A-".'),
        includePrefix: z.boolean().optional().describe('Show the prefix in page numbers.'),
        marker: z.string().optional().describe('Section marker text (insert it with a text variable).'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { document: _d, ...spec } = args;
        setSection(doc, spec);
        ctx.save(doc);
        const pages = listPages(doc);
        return ok(`Page numbering updated. Pages are now numbered: ${pages.map((p) => p.name).join(', ')}.`, {
          pages: pages.map((p) => ({ index: p.index, name: p.name })),
        });
      }),
  );

  server.registerTool(
    'anchor_item_in_text',
    {
      title: 'Anchor an item in text',
      description:
        'Moves an item into a story so it flows with the text (an anchored object in InDesign): an icon in a sentence, or a picture that stays with its paragraph.',
      inputSchema: z.object({
        document: documentParam,
        item: itemParam.describe('The item to anchor.'),
        intoFrame: itemParam.describe('The text frame whose story it should flow with.'),
        page: pageParam.optional(),
        afterText: z.string().optional().describe('Put it at this text; otherwise at the end of the story.'),
        position: z.enum(['inline', 'above-line', 'custom']).optional(),
        yOffset: lengthParam.optional().describe('Vertical offset from the baseline.'),
        xOffset: lengthParam.optional(),
        alignment: z.enum(['left', 'center', 'right']).optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const item = findItem(doc, args.item, args.page);
        const story = storyOf(doc, args.intoFrame, args.page);
        anchorItem(doc, story, item.element, {
          find: args.afterText,
          position: args.position,
          yOffset: ctx.ptOpt(args.yOffset),
          xOffset: ctx.ptOpt(args.xOffset),
          alignment: args.alignment,
        });
        ctx.save(doc);
        return ok(`"${args.item}" now flows with the text in "${args.intoFrame}".`);
      }),
  );

  server.registerTool(
    'insert_special_characters',
    {
      title: 'Insert special characters',
      description: `Replaces placeholders in a text frame with typographic characters. Available: ${Object.keys(SPECIAL_CHARACTERS).join(', ')}. Write them as <em-dash>, <bullet>, <non-breaking-space> in your text.`,
      inputSchema: z.object({ document: documentParam, item: itemParam, page: pageParam.optional() }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const story = storyOf(doc, args.item, args.page);
        let changed = 0;
        for (const content of Array.from(story.getElementsByTagName('Content')) as Element[]) {
          const text = content.textContent ?? '';
          const replaced = expandSpecialCharacters(text);
          if (replaced === text) continue;
          while (content.firstChild) content.removeChild(content.firstChild);
          content.appendChild(content.ownerDocument!.createTextNode(replaced));
          changed++;
        }
        ctx.save(doc);
        return ok(`Replaced placeholders in ${changed} text run(s).`, { runs: changed });
      }),
  );
}
