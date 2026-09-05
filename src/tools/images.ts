import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { type FitMode, fillFrameWithImage, placedImageInfo, placeImage, refitImage } from '../idml/images.ts';
import { itemSummary } from '../idml/inspect.ts';
import { findItem, itemSpreadBounds } from '../idml/items.ts';
import { listLayers } from '../idml/layers.ts';
import { formatLength } from '../idml/units.ts';
import { mimeFor, probeImage, saveImage, slugify } from '../images/files.ts';
import { type GeneratedImage, type ImageProvider, pickSize } from '../images/provider.ts';
import { thumbnailBase64 } from '../images/thumbnail.ts';
import type { ToolContext } from './context.ts';
import { documentParam, itemParam, lengthParam, ok, pageParam, run, type ToolResult } from './shared.ts';

const fitParam = z
  .enum(['fill', 'fit', 'stretch', 'center', 'frame-to-content'])
  .optional()
  .describe(
    "How the picture fits the frame: fill (default, fills the frame proportionally and crops), fit (whole picture visible), stretch, center (100 %), frame-to-content (frame takes the picture's size).",
  );

const targetParams = {
  page: pageParam.optional().describe('Page for a new frame (default 1).'),
  master: z.string().optional().describe('Place on this master page instead.'),
};

const frameParams = {
  x: lengthParam.optional(),
  y: lengthParam.optional(),
  width: lengthParam.optional(),
  height: lengthParam.optional(),
  frame: itemParam
    .optional()
    .describe('Put the image into this existing frame instead of creating a new one.'),
  name: z.string().optional(),
  layer: z.string().optional(),
};

const generationParams = {
  size: z
    .string()
    .optional()
    .describe(
      '"square", "landscape", "portrait", an aspect like "16:9" or "3:4", or exact pixels "1536x1024". Default: matches the frame, else square.',
    ),
  quality: z
    .enum(['low', 'medium', 'high', 'auto'])
    .optional()
    .describe('Higher quality costs more and takes longer. Default auto.'),
  transparentBackground: z
    .boolean()
    .optional()
    .describe('Produce a PNG with transparent background (logos, cut-outs).'),
  model: z
    .string()
    .optional()
    .describe('OpenAI image model (default gpt-image-2). Others: gpt-image-1.5, gpt-image-1-mini.'),
  fileName: z
    .string()
    .optional()
    .describe('File name for the saved image (without extension). Default: derived from the prompt.'),
  returnPreview: z
    .boolean()
    .optional()
    .describe('Include a small preview of the image in the reply (default true).'),
};

export function registerImageTools(server: McpServer, ctx: ToolContext, provider: ImageProvider): void {
  const summarize = (doc: import('../idml/document.ts').IdmlDocument, id: string) => {
    const found = findItem(doc, id);
    const layers = new Map(listLayers(doc).map((l) => [l.id, l.name]));
    return { ...itemSummary(found.info, ctx.unit, layers), placed: placedImageInfo(found.element) };
  };

  function resolvePlacement(
    doc: import('../idml/document.ts').IdmlDocument,
    args: {
      frame?: string;
      page?: number | string;
      master?: string;
      x?: string | number;
      y?: string | number;
      width?: string | number;
      height?: string | number;
      name?: string;
      layer?: string;
    },
    image: string,
    fit: FitMode | undefined,
  ) {
    if (args.frame) {
      const found = findItem(doc, args.frame, args.page);
      if (found.element.tagName === 'TextFrame')
        throw new Error(`"${args.frame}" is a text frame; pictures go into rectangles/ellipses`);
      const info = fillFrameWithImage(doc, found.element, { path: image, fit });
      if (args.name) found.element.setAttribute('Name', args.name);
      return { id: found.info.id, info };
    }
    if (args.x === undefined || args.y === undefined || args.width === undefined)
      throw new Error('Give x, y, width (and height) for a new frame, or frame to use an existing one');
    const probe = probeImage(image);
    const w = ctx.pt(args.width);
    const h = args.height !== undefined ? ctx.pt(args.height) : (w * probe.height) / probe.width;
    const target = args.master ? { master: args.master } : { page: args.page ?? 1 };
    const { frame, info } = placeImage(
      doc,
      target,
      {
        rect: { x: ctx.pt(args.x), y: ctx.pt(args.y), width: w, height: h },
        name: args.name,
        layer: args.layer,
      },
      { path: image, fit },
    );
    return { id: frame.getAttribute('Self')!, info };
  }

  function previewContent(img: GeneratedImage, want: boolean | undefined): ToolResult['content'] {
    if (want === false) return [];
    const thumb = thumbnailBase64(img.bytes, img.mimeType, 512);
    return thumb
      ? [
          { type: 'image', data: thumb.data, mimeType: thumb.mimeType } as unknown as {
            type: 'text';
            text: string;
          },
        ]
      : [];
  }

  server.registerTool(
    'place_image',
    {
      title: 'Place image',
      description:
        'Places an existing image file (PNG, JPEG, TIFF, PSD, PDF…) on a page: either in a new frame at x/y with width (height optional, keeps proportions) or into an existing frame. The file stays linked, like File > Place in InDesign; keep it next to the document (a Links folder is ideal).',
      inputSchema: z.object({
        document: documentParam,
        image: z.string().describe('Path to the image file.'),
        ...targetParams,
        ...frameParams,
        fit: fitParam,
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const image = ctx.resolvePath(args.image, { mustExist: true });
        const { id, info } = resolvePlacement(doc, args, image, args.fit);
        ctx.save(doc);
        const s = summarize(doc, id);
        return ok(
          `Placed ${basename(image)} (${info.width}×${info.height} px) in frame${s.name ? ` "${s.name}"` : ''} [${s.id}] ${s.position}, ${s.size}. Effective resolution ≈ ${s.placed?.effectivePpi ?? '?'} ppi.`,
          { item: s },
        );
      }),
  );

  server.registerTool(
    'set_image_fit',
    {
      title: 'Fit image',
      description:
        'Changes how a placed picture fits its frame (fill, fit, stretch, center, frame-to-content).',
      inputSchema: z.object({
        document: documentParam,
        frame: itemParam,
        page: pageParam.optional(),
        fit: z.enum(['fill', 'fit', 'stretch', 'center', 'frame-to-content']),
      }),
    },
    async (args) =>
      run(() => {
        const doc = ctx.open(args.document);
        const found = findItem(doc, args.frame, args.page);
        refitImage(found.element, args.fit);
        ctx.save(doc);
        return ok(`Fit set to ${args.fit}.`, { item: summarize(doc, found.info.id) });
      }),
  );

  server.registerTool(
    'generate_image',
    {
      title: 'Generate image (AI)',
      description:
        "Generates a picture with OpenAI from a text prompt, saves it in the document's Links folder and optionally places it: give x/y/width for a new frame or frame for an existing one. Without placement it only saves the file. Costs money per image, so confirm the prompt with the user before generating many.",
      inputSchema: z.object({
        document: documentParam,
        prompt: z.string().min(3),
        ...generationParams,
        ...targetParams,
        ...frameParams,
        fit: fitParam,
      }),
    },
    async (args) =>
      run(async () => {
        if (!provider.available)
          throw new Error(provider.unavailableReason ?? 'Image generation is not available');
        const doc = ctx.open(args.document);
        const model = args.model ?? (provider as { defaultModel?: string }).defaultModel ?? 'gpt-image-2';
        let sizeTarget: string | { width: number; height: number } | undefined = args.size;
        if (!sizeTarget) {
          if (args.frame) {
            const b = itemSpreadBounds(findItem(doc, args.frame, args.page).element);
            if (b) sizeTarget = { width: b.width, height: b.height };
          } else if (args.width !== undefined && args.height !== undefined)
            sizeTarget = { width: ctx.pt(args.width), height: ctx.pt(args.height) };
        }
        const size = pickSize(model, sizeTarget, args.quality ?? 'auto');
        const img = await provider.generate({
          prompt: args.prompt,
          size,
          quality: args.quality,
          background: args.transparentBackground ? 'transparent' : 'auto',
          outputFormat: args.transparentBackground ? 'png' : 'png',
          model,
        });
        const dir = ctx.linksDir(doc.path!);
        const path = saveImage(
          dir,
          slugify(args.fileName ?? args.prompt),
          img.mimeType === 'image/jpeg' ? 'jpg' : img.mimeType === 'image/webp' ? 'webp' : 'png',
          img.bytes,
        );
        let placedText = '';
        let item: Record<string, unknown> | undefined;
        if (args.frame || (args.x !== undefined && args.y !== undefined && args.width !== undefined)) {
          const { id } = resolvePlacement(doc, args, path, args.fit);
          ctx.save(doc);
          const s = summarize(doc, id);
          item = s;
          placedText = ` Placed in frame${s.name ? ` "${s.name}"` : ''} [${s.id}] ${s.position}, ${s.size}.`;
        }
        const result = ok(
          `Generated ${img.width}×${img.height} px image with ${img.model} → ${path}.${placedText}${img.revisedPrompt ? `\nPrompt used: ${img.revisedPrompt}` : ''}`,
          { path, width: img.width, height: img.height, model: img.model, item },
        );
        result.content.push(...previewContent(img, args.returnPreview));
        return result;
      }),
  );

  server.registerTool(
    'edit_image',
    {
      title: 'Edit image (AI)',
      description:
        'Edits or combines existing pictures with OpenAI: describe the change in the prompt, pass one or more source images (file paths or frame names whose picture should be used) and optionally a mask PNG whose transparent areas mark what to change. Saves the result to the Links folder and optionally places it (frame / x,y,width).',
      inputSchema: z.object({
        document: documentParam,
        prompt: z.string().min(3),
        images: z
          .array(z.string())
          .min(1)
          .max(16)
          .describe('Source image paths, or names/ids of frames containing pictures.'),
        mask: z.string().optional().describe('Path to a PNG mask (transparent = area to edit).'),
        ...generationParams,
        ...targetParams,
        ...frameParams,
        fit: fitParam,
        replaceInFrame: z
          .boolean()
          .optional()
          .describe('When a source is a frame, put the result back into that frame (default true).'),
      }),
    },
    async (args) =>
      run(async () => {
        if (!provider.available)
          throw new Error(provider.unavailableReason ?? 'Image generation is not available');
        const doc = ctx.open(args.document);
        const model = args.model ?? (provider as { defaultModel?: string }).defaultModel ?? 'gpt-image-2';
        const sources: { bytes: Uint8Array; mimeType: string; name: string }[] = [];
        let sourceFrame: string | undefined;
        for (const ref of args.images) {
          let path: string | undefined;
          try {
            path = ctx.resolvePath(ref, { mustExist: true });
          } catch {
            const found = findItem(doc, ref, args.page);
            const placed = placedImageInfo(found.element);
            if (!placed?.path)
              throw new Error(`"${ref}" is neither an image file nor a frame with a picture`);
            path = placed.path;
            sourceFrame ??= found.info.id;
          }
          sources.push({
            bytes: new Uint8Array(readFileSync(path)),
            mimeType: mimeFor(path),
            name: basename(path),
          });
        }
        const mask = args.mask
          ? (() => {
              const p = ctx.resolvePath(args.mask!, { mustExist: true });
              return { bytes: new Uint8Array(readFileSync(p)), mimeType: 'image/png', name: basename(p) };
            })()
          : undefined;
        const first = sources[0]!;
        const dims = (require('../images/files.ts') as typeof import('../images/files.ts')).imageDimensions(
          first.bytes,
        );
        const size = pickSize(
          model,
          args.size ?? (dims ? { width: dims.width, height: dims.height } : undefined),
          args.quality ?? 'auto',
        );
        const img = await provider.edit({
          prompt: args.prompt,
          size,
          quality: args.quality,
          background: args.transparentBackground ? 'transparent' : 'auto',
          outputFormat: 'png',
          model,
          images: sources,
          mask,
        });
        const dir = ctx.linksDir(doc.path!);
        const base = args.fileName ?? `${basename(first.name, extname(first.name))}-edited`;
        const path = saveImage(dir, slugify(base), 'png', img.bytes);
        let placedText = '';
        let item: Record<string, unknown> | undefined;
        const frameRef = args.frame ?? (args.replaceInFrame !== false ? sourceFrame : undefined);
        if (frameRef || (args.x !== undefined && args.y !== undefined && args.width !== undefined)) {
          const { id } = resolvePlacement(doc, { ...args, frame: frameRef }, path, args.fit);
          ctx.save(doc);
          const s = summarize(doc, id);
          item = s;
          placedText = ` Placed in frame${s.name ? ` "${s.name}"` : ''} [${s.id}].`;
        }
        const result = ok(
          `Edited image saved to ${path} (${img.width}×${img.height} px, ${img.model}).${placedText}`,
          { path, width: img.width, height: img.height, model: img.model, item },
        );
        result.content.push(...previewContent(img, args.returnPreview));
        return result;
      }),
  );

  server.registerTool(
    'list_images',
    {
      title: 'List placed images',
      description:
        'Lists every placed picture with its frame, file path, pixel size, scale and effective resolution (warns below 150 ppi for print).',
      inputSchema: z.object({ document: documentParam, page: pageParam.optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ document, page }) =>
      run(() => {
        const doc = ctx.open(document);
        const { listItems } = require('../idml/items.ts') as typeof import('../idml/items.ts');
        const items = listItems(doc, { page }).filter((i) => i.type === 'image');
        const rows = items.map((i) => {
          const el = findItem(doc, i.id).element;
          const p = placedImageInfo(el);
          return {
            id: i.id,
            name: i.name,
            page: i.page,
            path: p?.path,
            pixels: p ? `${p.widthPx}×${p.heightPx}` : undefined,
            scalePercent: p?.scalePercent,
            effectivePpi: p?.effectivePpi,
            size: i.bounds
              ? `${formatLength(i.bounds.width, ctx.unit)} × ${formatLength(i.bounds.height, ctx.unit)}`
              : undefined,
            lowResolution: p?.effectivePpi !== undefined && p.effectivePpi < 150,
          };
        });
        return ok(
          rows
            .map(
              (r) =>
                `p${r.page} ${r.name ? `"${r.name}" ` : ''}[${r.id}] ${r.path} ${r.pixels ?? ''} at ${r.scalePercent ?? '?'} % (${r.effectivePpi ?? '?'} ppi${r.lowResolution ? ', LOW for print' : ''})`,
            )
            .join('\n') || 'No placed images',
          { images: rows },
        );
      }),
  );
}
