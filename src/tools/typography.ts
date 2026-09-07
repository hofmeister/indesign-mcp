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
import {
  createTextVariable,
  deleteTextVariable,
  insertTextVariable,
  listTextVariables,
  readStyleAutomation,
  setGrepStyles,
  setLineStyles,
  setNestedStyles,
} from '../idml/variables.ts';
import { attr, type Element, getProperty } from '../idml/xml.ts';
import { fontCatalog } from '../preview/fonts.ts';
import { withNotes } from './checks.ts';
import type { ToolContext } from './context.ts';
import type { ToolRegistry } from './registry.ts';
import { documentParam, itemParam, lengthParam, ok, pageParam, run, toolInput } from './shared.ts';

function storyOf(doc: IdmlDocument, item: string, page?: number | string): Element {
  const found = findItem(doc, item, page);
  if (found.element.tagName !== 'TextFrame')
    throw new Error(`"${item}" is a ${found.info.type}, not a text frame`);
  const story = doc.story(attr(found.element, 'ParentStory') ?? '');
  if (!story) throw new Error('That text frame has no story');
  return story;
}

/**
 * InDesign draws the bullet in the font the list asks for and shows a missing-glyph box when that
 * font has no such character (Helvetica Neue has no ▪). Picks a font that does have it when the
 * caller named none, and says so either way.
 */
function bulletFontFor(
  doc: IdmlDocument,
  style: Element,
  character: string,
  requested: string | undefined,
): { font: string | undefined; notes: string[] } {
  const codePoint = character.codePointAt(0);
  if (!codePoint) return { font: requested, notes: [] };
  const catalog = fontCatalog();
  const family = requested ?? getProperty(style, 'AppliedFont')?.value;
  let has = false;
  try {
    const match = catalog.match(family, attr(style, 'FontStyle'));
    has = match.face.hasGlyphForCodePoint?.(codePoint) !== false;
  } catch {
    return { font: requested, notes: [] };
  }
  if (has) return { font: requested, notes: [] };
  const alternative = catalog.faceWithGlyph(codePoint)?.info.family;
  if (!alternative)
    return {
      font: requested,
      notes: [
        `no font on this computer has "${character}" — InDesign will draw a missing-glyph box; try • or – instead.`,
      ],
    };
  if (requested)
    return {
      font: requested,
      notes: [
        `"${requested}" has no "${character}", so InDesign will draw a missing-glyph box there. "${alternative}" has the glyph — or use • or –, which every text font carries.`,
      ],
    };
  return {
    font: alternative,
    notes: [
      `${family ?? 'the text font'} has no "${character}", so the bullet is set in ${alternative}. InDesign can still show an uncommon symbol as a missing-glyph box — • and – are the safe choices.`,
    ],
  };
}

export function registerTypographyTools(reg: ToolRegistry, ctx: ToolContext): void {
  reg.tool(
    'set_list_options',
    {
      title: 'Bullets and numbering',
      description:
        'Turns a paragraph style into a bulleted or numbered list (or switches the list off). Apply the style to paragraphs as usual; InDesign then draws the bullets or numbers.',
      inputSchema: toolInput({
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
          .describe(
            'Pattern, e.g. "^#." for 1. or "^#)" for 1). ^# is the number, ^t a tab. textAfter is appended to it.',
          ),
        startAt: z.number().int().min(1).optional(),
        textAfter: z.string().optional().describe('What follows the bullet/number, default a tab (^t).'),
        indent: lengthParam.optional().describe('Left indent of the paragraph.'),
        bulletIndent: lengthParam.optional().describe('How far the bullet/number hangs into the margin.'),
        characterStyle: z.string().optional().describe('Character style for the bullet/number itself.'),
        font: z.string().optional().describe('Font for the bullet character.'),
        fontStyle: z.string().optional().describe('Style of that font, e.g. "Bold" (default Regular).'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const style = resolveStyle(doc, 'ParagraphStyle', args.style);
        const bullet =
          args.kind === 'bullet'
            ? bulletFontFor(doc, style, args.bulletCharacter ?? '•', args.font)
            : { font: args.font, notes: [] as string[] };
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
          font: bullet.font,
          fontStyle: args.fontStyle,
        });
        ctx.save(doc);
        return ok(
          withNotes(
            args.kind === 'none'
              ? `"${args.style}" is no longer a list.`
              : `"${args.style}" is now a ${args.kind === 'bullet' ? `bulleted list (${args.bulletCharacter ?? '•'})` : `numbered list (${args.numberStyle ?? 'arabic'})`}.`,
            bullet.notes,
          ),
          { notes: bullet.notes },
        );
      }),
  );

  reg.tool(
    'set_tab_stops',
    {
      title: 'Tab stops',
      description:
        'Sets the tab stops of a paragraph style — useful for price lists and tables of contents (a right tab with a dotted leader).',
      inputSchema: toolInput({
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

  reg.tool(
    'add_hyperlink',
    {
      title: 'Add hyperlink',
      description:
        'Turns text into a hyperlink to a web address. The link survives PDF and EPUB export from InDesign.',
      inputSchema: toolInput({
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

  reg.listing(
    'hyperlinks',
    {
      title: 'List hyperlinks',
      description: 'Lists the hyperlinks in the document with their targets.',
      inputSchema: toolInput({ document: documentParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(() => {
        const links = listHyperlinks(ctx.open(document));
        return ok(links.map((l) => `${l.name} → ${l.url}`).join('\n') || 'No hyperlinks', { links });
      }),
  );

  reg.tool(
    'set_page_numbering',
    {
      title: 'Page numbering and sections',
      description:
        'Controls how pages are numbered: where a section starts, the first number, the style (1, i, I, a, A) and a section prefix. Combine with insert_page_number on a master page.',
      inputSchema: toolInput({
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

  reg.tool(
    'anchor_item_in_text',
    {
      title: 'Anchor an item in text',
      description:
        'Moves an item into a story so it flows with the text (an anchored object in InDesign): an icon in a sentence, or a picture that stays with its paragraph.',
      inputSchema: toolInput({
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

  reg.tool(
    'insert_special_characters',
    {
      title: 'Insert special characters',
      description: `Replaces placeholders in a text frame with typographic characters. Available: ${Object.keys(SPECIAL_CHARACTERS).join(', ')}. Write them as <em-dash>, <bullet>, <non-breaking-space> in your text.`,
      inputSchema: toolInput({ document: documentParam, item: itemParam, page: pageParam.optional() }),
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

export function registerVariableTools(reg: ToolRegistry, ctx: ToolContext): void {
  reg.tool(
    'create_text_variable',
    {
      title: 'Create a text variable',
      description:
        'Makes a text variable: a running header that repeats the current heading, the date, the file name, the chapter number, the last page number, or a piece of custom text you can change in one place. Put it into a frame with insert_text_variable, usually on a master page.',
      inputSchema: toolInput({
        document: documentParam,
        name: z.string().describe('What to call it, e.g. "Running head".'),
        kind: z.enum([
          'custom-text',
          'file-name',
          'last-page-number',
          'chapter-number',
          'creation-date',
          'modification-date',
          'output-date',
          'running-header-paragraph',
          'running-header-character',
        ]),
        text: z.string().optional().describe('The text, for a custom-text variable.'),
        format: z
          .string()
          .optional()
          .describe('Date pattern for the date variables, e.g. "d MMMM yyyy" or "dd/MM/yyyy".'),
        style: z
          .string()
          .optional()
          .describe('The style a running header follows, e.g. the "Heading 1" paragraph style.'),
        use: z
          .enum(['first', 'last'])
          .optional()
          .describe('Which match on the page a running header takes (default the first).'),
        textBefore: z.string().optional(),
        textAfter: z.string().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { document: _d, ...spec } = args;
        createTextVariable(doc, spec);
        ctx.save(doc);
        return ok(`Text variable "${args.name}" created (${args.kind}).`, {
          variables: listTextVariables(doc),
        });
      }),
  );

  reg.listing(
    'text_variables',
    {
      title: 'List text variables',
      description: "Lists the document's text variables and what each one shows.",
      inputSchema: toolInput({ document: documentParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(() => {
        const variables = listTextVariables(ctx.open(document));
        return ok(
          variables.map((v) => `${v.name} — ${v.kind}${v.detail ? ` (${v.detail})` : ''}`).join('\n') ||
            'No text variables',
          { variables },
        );
      }),
  );

  reg.tool(
    'insert_text_variable',
    {
      title: 'Insert a text variable',
      description:
        'Puts a text variable into a text frame — in place of some text you name, or at the end of the story. On a master page this gives every page a running header or a date that updates itself.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam.describe('The text frame.'),
        page: pageParam.optional(),
        variable: z.string().describe('Name of the variable (see list text_variables).'),
        replaceText: z.string().optional().describe('Text to replace with the variable.'),
        characterStyle: z.string().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const story = storyOf(doc, args.item, args.page);
        insertTextVariable(doc, story, args.variable, {
          find: args.replaceText,
          characterStyle: args.characterStyle,
        });
        ctx.save(doc);
        return ok(`"${args.variable}" inserted into "${args.item}".`);
      }),
  );

  reg.tool(
    'delete_text_variable',
    {
      title: 'Delete a text variable',
      description: 'Removes a text variable from the document.',
      inputSchema: toolInput({ document: documentParam, name: z.string() }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        deleteTextVariable(doc, args.name);
        ctx.save(doc);
        return ok(`Text variable "${args.name}" deleted.`);
      }),
  );

  reg.tool(
    'set_nested_styles',
    {
      title: 'Nested styles',
      description:
        'Styles the start of every paragraph automatically: "the first two words in Bold", "everything up to the first colon in Small caps". InDesign calls these nested styles; they follow the paragraph style, so the text stays editable.',
      inputSchema: toolInput({
        document: documentParam,
        style: z.string().describe('The paragraph style to change.'),
        nested: z
          .array(
            z.object({
              characterStyle: z.string(),
              through: z
                .string()
                .describe(
                  'Where it stops: a literal string like ":" or " — ", or one of Sentence, AnyWord, AnyCharacter, Letters, Digits, Tabs, ForcedLineBreak, EndNestedStyle, EmSpace, EnSpace, NonbreakingSpace.',
                ),
              repetition: z.number().int().min(1).optional().describe('How many of them, e.g. 2 words.'),
              inclusive: z
                .boolean()
                .optional()
                .describe('Include the delimiter itself in the styled text (default true).'),
            }),
          )
          .describe('In order, from the start of the paragraph. An empty list removes them.'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const style = resolveStyle(doc, 'ParagraphStyle', args.style);
        setNestedStyles(doc, style, args.nested);
        ctx.save(doc);
        return ok(
          args.nested.length
            ? `"${args.style}" now applies ${args.nested.length} nested style(s).`
            : `Nested styles removed from "${args.style}".`,
          { ...readStyleAutomation(style) },
        );
      }),
  );

  reg.tool(
    'set_line_styles',
    {
      title: 'Line styles',
      description:
        'Styles whole lines of every paragraph in a style — "the first line in small caps", for instance.',
      inputSchema: toolInput({
        document: documentParam,
        style: z.string(),
        lines: z.array(
          z.object({
            characterStyle: z.string(),
            lines: z.number().int().min(1).optional().describe('How many lines (default 1).'),
            repeat: z.boolean().optional().describe('Repeat the pattern down the paragraph.'),
          }),
        ),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const style = resolveStyle(doc, 'ParagraphStyle', args.style);
        setLineStyles(doc, style, args.lines);
        ctx.save(doc);
        return ok(`"${args.style}" now applies ${args.lines.length} line style(s).`, {
          ...readStyleAutomation(style),
        });
      }),
  );

  reg.tool(
    'set_grep_styles',
    {
      title: 'GREP styles',
      description:
        "Styles every match of a pattern inside the paragraphs of a style — phone numbers in bold, acronyms in small caps, prices in a different colour. Uses InDesign's GREP (regular expression) syntax.",
      inputSchema: toolInput({
        document: documentParam,
        style: z.string(),
        grep: z
          .array(
            z.object({
              characterStyle: z.string(),
              pattern: z
                .string()
                .describe(
                  'GREP pattern, e.g. "\\d+([.,]\\d+)?" for numbers or "\\b[A-Z]{2,}\\b" for acronyms.',
                ),
            }),
          )
          .describe('An empty list removes the GREP styles.'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const style = resolveStyle(doc, 'ParagraphStyle', args.style);
        setGrepStyles(doc, style, args.grep);
        ctx.save(doc);
        return ok(
          args.grep.length
            ? `"${args.style}" now applies ${args.grep.length} GREP style(s).`
            : `GREP styles removed from "${args.style}".`,
          { ...readStyleAutomation(style) },
        );
      }),
  );
}
