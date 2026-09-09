// Tool parameters and the wait_for_image handler, shared by the InDesign server and the
// standalone image server.
import * as z from 'zod';
import type { ImageJobs } from './jobs.ts';
import { elapsedText } from './jobs.ts';
import { type ImageJobResult, jobToolResult } from './result.ts';

/** How long a generating tool waits before handing back a job id, in seconds. */
export const DEFAULT_WAIT_SECONDS = 45;

export const waitSecondsParam = z
  .number()
  .min(0)
  .max(600)
  .optional()
  .describe(
    `How long to wait for the picture before returning a job id instead, in seconds (default ${DEFAULT_WAIT_SECONDS}, 0 returns the job id at once). Keep it under your own tool timeout: nothing is lost when the wait runs out, wait_for_image picks the job up again.`,
  );

/** Options every generating tool takes, whatever it does with the finished picture. */
export const generationParams = {
  size: z
    .string()
    .optional()
    .describe(
      '"square", "landscape", "portrait", an aspect like "16:9" or "3:4", or exact pixels "1536x1024".',
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
  waitSeconds: waitSecondsParam,
};

export const waitForImageInput = {
  id: z
    .string()
    .optional()
    .describe('The job id returned by generate_image / edit_image. Default: the job still running.'),
  waitSeconds: z
    .number()
    .min(0)
    .max(600)
    .optional()
    .describe(
      `How long to wait this time, in seconds (default ${DEFAULT_WAIT_SECONDS}). If it comes back still running, just call again.`,
    ),
  returnPreview: z.boolean().optional().describe('Include a preview of the image (default true).'),
};

export const WAIT_FOR_IMAGE_DESCRIPTION =
  'Collects a picture from generate_image or edit_image that was not ready in time. Waits for the job and returns the finished image, or reports that it is still running — in which case call this again with the same id, as many times as it takes. Generation is not interrupted or restarted by waiting or by giving up on a wait.';

export async function runWaitForImage(
  jobs: ImageJobs<ImageJobResult>,
  args: { id?: string; waitSeconds?: number; returnPreview?: boolean },
): Promise<ReturnType<typeof jobToolResult>> {
  const job = args.id ? jobs.get(args.id) : jobs.pending();
  if (!job) {
    const known = jobs.list();
    throw new Error(
      args.id
        ? `No image job "${args.id}". It may have expired; start a new generation.${known.length ? ` Known jobs: ${known.map((j) => j.id).join(', ')}.` : ''}`
        : 'No image job is running. Start one with generate_image or edit_image.',
    );
  }
  const settled = await jobs.wait(job.id, (args.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000);
  return jobToolResult(jobs, settled, args.returnPreview);
}

export function jobListText(jobs: ImageJobs<ImageJobResult>): string {
  const all = jobs.list();
  if (!all.length) return 'No image jobs.';
  return all
    .map(
      (j) =>
        `${j.id} ${j.status}${j.status === 'running' ? ` (${elapsedText(j)} so far)` : ''} — ${j.kind} "${j.prompt}" ${j.model} ${j.size}${j.error ? `: ${j.error}` : ''}`,
    )
    .join('\n');
}
