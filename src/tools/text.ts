import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { IdmlDocument } from '../idml/document.ts';
import { findItem, listItems } from '../idml/items.ts';
import {
  appendPageNumberMarker,
  appendStoryText,
  applyParagraphStyle,
  findInStory,
  formatMatches,
  type Paragraph,
  readStory,
  readStoryPlainText,
  replaceInStory,
  setStoryText,
} from '../idml/stories.ts';
import { resolveSwatch, styleSelf, textStyleAttrs } from '../idml/styles.ts';
import { attr, type Element } from '../idml/xml.ts';
import type { ToolContext } from './context.ts';
import {
  colorParam,
  documentParam,
  itemParam,
  ok,
  pageParam,
  paragraphInput,
  run,
  toolInput,
} from './shared.ts';

function storyOf(
  doc: IdmlDocument,
  item: string,
  page?: number | string,
): { story: Element; frame: Element } {
  const found = findItem(doc, item, page);
  if (found.element.tagName !== 'TextFrame')
    throw new Error(`"${item}" is a ${found.info.type}, not a text frame`);
  const story = doc.story(attr(found.element, 'ParentStory') ?? '');
  if (!story) throw new Error('The text frame has no story');
  return { story, frame: found.element };
}

function toParagraphs(
  doc: IdmlDocument,
  text: string | undefined,
  paragraphs: { text: string; style?: string }[] | undefined,
  defaultStyle: string | undefined,
  markup: boolean,
): string | Paragraph[] {
  const fallback = defaultStyle
    ? styleSelf(doc, 'ParagraphStyle', defaultStyle)
    : 'ParagraphStyle/$ID/NormalParagraphStyle';
  if (paragraphs?.length) {
    const { parseInlineMarkup } = require('../idml/stories.ts') as typeof import('../idml/stories.ts');
    return paragraphs.map((p) => ({
      style: p.style ? styleSelf(doc, 'ParagraphStyle', p.style) : fallback,
      runs: markup ? parseInlineMarkup(p.text) : [{ text: p.text }],
    }));
  }
  return text ?? '';
}

export function registerTextTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_text',
    {
      title: 'Get text',
      description:
        'Returns the text of a text frame (or of every text frame in the document), paragraph by paragraph with style names.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam.optional(),
        page: pageParam.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ document, item, page }) =>
      run(() => {
        const doc = ctx.open(document);
        if (item) {
          const { story } = storyOf(doc, item, page);
          const paras = readStory(story).map((p, i) => ({
            n: i + 1,
            style: p.style
              .replace(/^ParagraphStyle\//, '')
              .replace(/^\$ID\/NormalParagraphStyle$/, '[Basic Paragraph]'),
            text: p.runs.map((r) => r.text).join(''),
          }));
          return ok(paras.map((p) => `${p.n}. [${p.style}] ${p.text}`).join('\n'), { paragraphs: paras });
        }
        const frames = listItems(doc, { page }).filter((i) => i.type === 'text');
        return ok(
          frames
            .map((f) => `${f.name ? `"${f.name}" ` : ''}[${f.id}] page ${f.page}:\n${f.text}`)
            .join('\n\n') || 'No text frames',
          {
            frames: frames.map((f) => ({ id: f.id, name: f.name, page: f.page, text: f.text })),
          },
        );
      }),
  );

  server.registerTool(
    'set_text',
    {
      title: 'Set text',
      description:
        'Replaces all text in a text frame. Use `text` (newlines = paragraphs) or `paragraphs` for per-paragraph styles.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        text: z.string().optional(),
        paragraphs: z.array(paragraphInput).optional(),
        paragraphStyle: z.string().optional().describe('Default paragraph style for all paragraphs.'),
        markup: z.boolean().optional().describe('Interpret **bold**/*italic* (default true).'),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { story } = storyOf(doc, args.item, args.page);
        const content = toParagraphs(
          doc,
          args.text,
          args.paragraphs,
          args.paragraphStyle,
          args.markup !== false,
        );
        setStoryText(doc, story, content, {
          paragraphStyle: args.paragraphStyle
            ? styleSelf(doc, 'ParagraphStyle', args.paragraphStyle)
            : undefined,
          markup: args.markup !== false,
        });
        ctx.save(doc);
        return ok(`Text replaced (${readStory(story).length} paragraph(s)).`);
      }),
  );

  server.registerTool(
    'append_text',
    {
      title: 'Append text',
      description: "Adds paragraphs at the end of a text frame's text.",
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        text: z.string().optional(),
        paragraphs: z.array(paragraphInput).optional(),
        paragraphStyle: z.string().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { story } = storyOf(doc, args.item, args.page);
        appendStoryText(
          doc,
          story,
          toParagraphs(doc, args.text, args.paragraphs, args.paragraphStyle, true),
          {
            paragraphStyle: args.paragraphStyle
              ? styleSelf(doc, 'ParagraphStyle', args.paragraphStyle)
              : undefined,
          },
        );
        ctx.save(doc);
        return ok(`Text appended (${readStory(story).length} paragraph(s) now).`);
      }),
  );

  server.registerTool(
    'find_and_replace',
    {
      title: 'Find and replace',
      description:
        'Finds and replaces text across the whole document or inside one text frame. Supports regular expressions.',
      inputSchema: toolInput({
        document: documentParam,
        find: z.string(),
        replace: z.string().optional().describe('Omit to only count matches.'),
        item: itemParam.optional(),
        page: pageParam.optional(),
        regex: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        wholeWord: z.boolean().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const stories: Element[] = [];
        if (args.item) stories.push(storyOf(doc, args.item, args.page).story);
        else
          for (const part of doc.storyParts())
            stories.push(...(Array.from(doc.xml(part).getElementsByTagName('Story')) as Element[]));
        const o = { regex: args.regex, caseSensitive: args.caseSensitive, wholeWord: args.wholeWord };
        let n = 0;
        for (const s of stories)
          n +=
            args.replace === undefined
              ? findInStory(s, args.find, o)
              : replaceInStory(s, args.find, args.replace, o);
        if (args.replace !== undefined) ctx.save(doc);
        return ok(args.replace === undefined ? `Found ${n} match(es).` : `Replaced ${n} occurrence(s).`, {
          count: n,
        });
      }),
  );

  server.registerTool(
    'apply_paragraph_style',
    {
      title: 'Apply paragraph style',
      description:
        'Applies a paragraph style to all paragraphs of a text frame, to specific paragraph numbers, or to paragraphs containing some text.',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        style: z.string(),
        paragraphs: z.array(z.number().int().positive()).optional().describe('1-based paragraph numbers.'),
        containing: z.string().optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { story } = storyOf(doc, args.item, args.page);
        const n = applyParagraphStyle(story, styleSelf(doc, 'ParagraphStyle', args.style), {
          paragraphs: args.paragraphs,
          containing: args.containing,
        });
        ctx.save(doc);
        return ok(`Applied "${args.style}" to ${n} paragraph(s).`, { count: n });
      }),
  );

  server.registerTool(
    'format_text',
    {
      title: 'Format text',
      description:
        'Formats every occurrence of some text inside a frame (or the whole document): apply a character style, or local formatting such as bold, italic, size, font, color, tracking.',
      inputSchema: toolInput({
        document: documentParam,
        find: z.string().describe('The text to format (exact, case-insensitive by default).'),
        item: itemParam.optional(),
        page: pageParam.optional(),
        regex: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        characterStyle: z.string().optional(),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        fontStyle: z
          .string()
          .optional()
          .describe('Exact font style name, e.g. "Semibold Italic" (overrides bold/italic).'),
        font: z.string().optional(),
        size: z.number().positive().optional(),
        color: colorParam.optional(),
        tracking: z.number().optional(),
        underline: z.boolean().optional(),
        capitalization: z.enum(['normal', 'small-caps', 'all-caps']).optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const stories: Element[] = args.item
          ? [storyOf(doc, args.item, args.page).story]
          : doc
              .storyParts()
              .flatMap((p) => Array.from(doc.xml(p).getElementsByTagName('Story')) as Element[]);
        const { attrs, props } = textStyleAttrs(doc, {
          font: args.font,
          size: args.size,
          color: args.color,
          tracking: args.tracking,
          underline: args.underline,
          capitalization: args.capitalization,
        });
        const a: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(attrs)) if (v !== undefined) a[k] = v === null ? null : String(v);
        if (args.fontStyle) a.FontStyle = args.fontStyle;
        else if (args.bold !== undefined || args.italic !== undefined)
          a.FontStyle =
            args.bold && args.italic
              ? 'Bold Italic'
              : args.bold
                ? 'Bold'
                : args.italic
                  ? 'Italic'
                  : 'Regular';
        const p: Record<string, { type: string; value: string } | null> = {};
        for (const [k, v] of Object.entries(props))
          p[k] = v ? { type: v.type, value: String(v.value) } : null;
        let n = 0;
        for (const s of stories)
          n += formatMatches(
            s,
            args.find,
            {
              characterStyle: args.characterStyle
                ? styleSelf(doc, 'CharacterStyle', args.characterStyle)
                : undefined,
              attrs: a,
              props: p,
            },
            { regex: args.regex, caseSensitive: args.caseSensitive },
          );
        ctx.save(doc);
        return ok(`Formatted ${n} occurrence(s).`, { count: n });
      }),
  );

  server.registerTool(
    'insert_page_number',
    {
      title: 'Insert page number',
      description:
        'Adds an automatic page-number marker to a text frame, typically a small frame on a master page (create it with add_text_frame using master).',
      inputSchema: toolInput({
        document: documentParam,
        item: itemParam,
        page: pageParam.optional(),
        prefix: z.string().optional(),
        suffix: z.string().optional(),
        paragraphStyle: z
          .string()
          .optional()
          .describe(
            'Paragraph style for the marker. Only needed for an empty frame: in a frame that already has text the marker matches the text it is added to.',
          ),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const { story } = storyOf(doc, args.item, args.page);
        appendPageNumberMarker(story, {
          prefix: args.prefix,
          suffix: args.suffix,
          paragraphStyle: args.paragraphStyle,
        });
        ctx.save(doc);
        return ok('Page number marker inserted.');
      }),
  );

  server.registerTool(
    'thread_text_frames',
    {
      title: 'Thread text frames',
      description:
        "Links two text frames so text overflowing the first continues in the second. The second frame's own text is discarded.",
      inputSchema: toolInput({
        document: documentParam,
        from: itemParam,
        to: itemParam,
        page: pageParam.optional(),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const a = findItem(doc, args.from, args.page);
        const b = findItem(doc, args.to);
        if (a.element.tagName !== 'TextFrame' || b.element.tagName !== 'TextFrame')
          throw new Error('Both items must be text frames');
        if (attr(a.element, 'NextTextFrame') !== 'n')
          throw new Error(`"${args.from}" is already threaded to another frame`);
        if (attr(b.element, 'PreviousTextFrame') !== 'n')
          throw new Error(`"${args.to}" already continues another frame`);
        const oldStory = attr(b.element, 'ParentStory');
        b.element.setAttribute('ParentStory', attr(a.element, 'ParentStory')!);
        a.element.setAttribute('NextTextFrame', attr(b.element, 'Self')!);
        b.element.setAttribute('PreviousTextFrame', attr(a.element, 'Self')!);
        if (oldStory) {
          const { removeItemElement } = require('../idml/pages.ts') as typeof import('../idml/pages.ts');
          // drop the orphaned story by simulating a frame removal on a detached clone
          const part = doc.storyPartName(oldStory);
          if (part) {
            doc.removePart(part);
            const ref = Array.from(doc.root.childNodes).find(
              (c) =>
                (c as Element).tagName === 'idPkg:Story' && (c as Element).getAttribute?.('src') === part,
            ) as Element | undefined;
            if (ref) doc.root.removeChild(ref);
            doc.root.setAttribute(
              'StoryList',
              (attr(doc.root, 'StoryList') ?? '')
                .split(/\s+/)
                .filter((s) => s && s !== oldStory)
                .join(' '),
            );
          }
          void removeItemElement;
        }
        ctx.save(doc);
        return ok(`Threaded "${args.from}" → "${args.to}".`);
      }),
  );

  void resolveSwatch;
  void readStoryPlainText;
}
