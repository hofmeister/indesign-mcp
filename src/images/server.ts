// A standalone MCP server for OpenAI image generation and editing.
//
// It shares the provider, the job runner and the size rules with the InDesign server, but knows
// nothing about documents: pictures are written to a folder and reported by path, so it is useful
// on its own. Start it with `indesign-mcp images`.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { expandHome } from '../config.ts';
import { ok, run, toolInput } from '../tools/shared.ts';
import { VERSION } from '../version.ts';
import { imageDimensions, mimeFor, saveImage, slugify } from './files.ts';
import { ImageJobs } from './jobs.ts';
import { OpenAIImageProvider } from './openai.ts';
import { type ImageProvider, pickSize } from './provider.ts';
import { type ImageJobResult, jobToolResult } from './result.ts';
import {
  DEFAULT_WAIT_SECONDS,
  generationParams,
  jobListText,
  runWaitForImage,
  WAIT_FOR_IMAGE_DESCRIPTION,
  waitForImageInput,
} from './tools.ts';

export const IMAGE_SERVER_INSTRUCTIONS = `This server generates and edits pictures with OpenAI's image models and writes them to a folder on this machine.

How to work:
1. generate_image makes a picture from a prompt; edit_image changes or combines pictures you pass as file paths, optionally through a mask PNG whose transparent areas mark what to change.
2. Both cost money per picture, so agree the prompt with the user before generating many.
3. A picture takes anywhere from ten seconds to several minutes. Both tools wait a while and then hand back a job id instead of failing: call wait_for_image with that id to collect the picture, and call it again as often as needed if it is still running. Waiting never restarts or cancels the work, and a finished picture stays collectable.
4. Every picture is saved as a file; the reply gives the full path. Say where it went so the user can find it.
5. Sizes: give "square", "landscape", "portrait", an aspect like "16:9", or exact pixels; the server picks the nearest size the model supports.`;

export interface ImageServerConfig {
  apiKey: string | undefined;
  model: string;
  /** Where generated pictures are written when no folder is given. */
  outputDir: string;
}

export function loadImageConfig(env: NodeJS.ProcessEnv = process.env): ImageServerConfig {
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || undefined,
    model: (env.IMAGE_MCP_MODEL ?? env.INDESIGN_MCP_IMAGE_MODEL)?.trim() || 'gpt-image-2',
    outputDir: expandHome(env.IMAGE_MCP_OUTPUT?.trim() || `${homedir()}/Documents/AI Images`),
  };
}

export interface ImageServerDeps {
  imageProvider?: ImageProvider;
}

export function createImageServer(
  config: ImageServerConfig = loadImageConfig(),
  deps: ImageServerDeps = {},
): McpServer {
  const server = new McpServer(
    { name: 'openai-image-mcp', version: VERSION },
    { instructions: IMAGE_SERVER_INSTRUCTIONS },
  );
  const provider = deps.imageProvider ?? new OpenAIImageProvider(config.apiKey, config.model);
  const jobs = new ImageJobs<ImageJobResult>();
  const defaultModel = (provider as { defaultModel?: string }).defaultModel ?? config.model;

  const outputParam = z
    .string()
    .optional()
    .describe(`Folder to save the picture in (default ${config.outputDir}).`);

  function outputDir(dir: string | undefined): string {
    const path = dir ? expandHome(dir.trim()) : config.outputDir;
    const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
    mkdirSync(abs, { recursive: true });
    return abs;
  }

  function sourceFile(ref: string): { bytes: Uint8Array; mimeType: string; name: string } {
    let path = expandHome(ref.trim());
    if (!isAbsolute(path)) {
      const inOutput = resolve(config.outputDir, path);
      path = existsSync(inOutput) ? inOutput : resolve(process.cwd(), path);
    }
    if (!existsSync(path)) throw new Error(`Image file not found: ${path}`);
    return { bytes: new Uint8Array(readFileSync(path)), mimeType: mimeFor(path), name: basename(path) };
  }

  function requireProvider(): void {
    if (!provider.available)
      throw new Error(provider.unavailableReason ?? 'Image generation is not available');
  }

  server.registerTool(
    'server_info',
    {
      title: 'Server info',
      description: 'Returns the version of the image server, the model it uses and its output folder.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const output = {
        version: VERSION,
        model: defaultModel,
        outputDir: config.outputDir,
        imageGeneration: provider.available,
        ...(provider.available ? {} : { reason: provider.unavailableReason }),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    'generate_image',
    {
      title: 'Generate image (AI)',
      description:
        'Generates a picture with OpenAI from a text prompt and saves it as a file. Generation runs in the background: when the picture is not ready within waitSeconds you get a job id and collect it with wait_for_image — nothing is lost and nothing is generated twice. Costs money per picture, so confirm the prompt with the user before generating many.',
      inputSchema: toolInput({
        prompt: z.string().min(3).describe('What the picture should show.'),
        ...generationParams,
        outputDir: outputParam,
      }),
    },
    async (args) =>
      run(async () => {
        requireProvider();
        const model = args.model ?? defaultModel;
        const size = pickSize(model, args.size, args.quality ?? 'auto');
        const dir = outputDir(args.outputDir);
        const job = jobs.start({ kind: 'generate', prompt: args.prompt, model, size }, async () => {
          const img = await provider.generate({
            prompt: args.prompt,
            size,
            quality: args.quality,
            background: args.transparentBackground ? 'transparent' : 'auto',
            outputFormat: 'png',
            model,
          });
          const path = saveImage(
            dir,
            slugify(args.fileName ?? args.prompt),
            img.mimeType === 'image/jpeg' ? 'jpg' : img.mimeType === 'image/webp' ? 'webp' : 'png',
            img.bytes,
          );
          return {
            text: `Generated ${img.width}×${img.height} px image with ${img.model} → ${path}${img.revisedPrompt ? `\nPrompt used: ${img.revisedPrompt}` : ''}`,
            data: { path, width: img.width, height: img.height, model: img.model },
            preview: { bytes: img.bytes, mimeType: img.mimeType },
          };
        });
        const settled = await jobs.wait(job.id, (args.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000);
        return jobToolResult(jobs, settled, args.returnPreview);
      }),
  );

  server.registerTool(
    'edit_image',
    {
      title: 'Edit image (AI)',
      description:
        'Edits or combines existing pictures with OpenAI: describe the change in the prompt and pass one or more image files, optionally with a mask PNG whose transparent areas mark what to change. Saves the result as a new file. Runs in the background like generate_image: collect a slow edit with wait_for_image.',
      inputSchema: toolInput({
        prompt: z.string().min(3).describe('The change to make, or how to combine the pictures.'),
        images: z.array(z.string()).min(1).max(16).describe('Paths of the source image files.'),
        mask: z.string().optional().describe('Path to a PNG mask (transparent = area to edit).'),
        ...generationParams,
        outputDir: outputParam,
      }),
    },
    async (args) =>
      run(async () => {
        requireProvider();
        const model = args.model ?? defaultModel;
        const sources = args.images.map(sourceFile);
        const mask = args.mask ? { ...sourceFile(args.mask), mimeType: 'image/png' } : undefined;
        const first = sources[0]!;
        const dims = imageDimensions(first.bytes);
        const size = pickSize(
          model,
          args.size ?? (dims ? { width: dims.width, height: dims.height } : undefined),
          args.quality ?? 'auto',
        );
        const dir = outputDir(args.outputDir);
        const job = jobs.start({ kind: 'edit', prompt: args.prompt, model, size }, async () => {
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
          const base = args.fileName ?? `${basename(first.name, extname(first.name))}-edited`;
          const path = saveImage(dir, slugify(base), 'png', img.bytes);
          return {
            text: `Edited image saved to ${path} (${img.width}×${img.height} px, ${img.model}).`,
            data: { path, width: img.width, height: img.height, model: img.model },
            preview: { bytes: img.bytes, mimeType: img.mimeType },
          };
        });
        const settled = await jobs.wait(job.id, (args.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000);
        return jobToolResult(jobs, settled, args.returnPreview);
      }),
  );

  server.registerTool(
    'wait_for_image',
    {
      title: 'Wait for image (AI)',
      description: WAIT_FOR_IMAGE_DESCRIPTION,
      inputSchema: toolInput(waitForImageInput),
    },
    async (args) => run(() => runWaitForImage(jobs, args)),
  );

  server.registerTool(
    'list_image_jobs',
    {
      title: 'List image jobs',
      description: 'Lists the image jobs of this session with their id and state (running, done, error).',
      inputSchema: toolInput({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(() =>
        ok(jobListText(jobs), {
          jobs: jobs.list().map((j) => ({
            id: j.id,
            status: j.status,
            kind: j.kind,
            prompt: j.prompt,
            model: j.model,
            size: j.size,
            error: j.error,
          })),
        }),
      ),
  );

  return server;
}
