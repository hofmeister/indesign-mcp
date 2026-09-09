// Turning an image job into an MCP tool result, the same way in both servers.
import type { ImageJob, ImageJobs } from './jobs.ts';
import { elapsedText } from './jobs.ts';
import { thumbnailBase64 } from './thumbnail.ts';

/** What the work of a job produces: the text to report, the fields to return, and what to show. */
export interface ImageJobResult {
  text: string;
  data: Record<string, unknown>;
  preview?: { bytes: Uint8Array; mimeType: string };
}

interface ToolResultLike {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function previewContent(result: ImageJobResult, want: boolean | undefined): { type: 'text'; text: string }[] {
  if (want === false || !result.preview) return [];
  const thumb = thumbnailBase64(result.preview.bytes, result.preview.mimeType, 512);
  if (!thumb) return [];
  return [
    { type: 'image', data: thumb.data, mimeType: thumb.mimeType } as unknown as {
      type: 'text';
      text: string;
    },
  ];
}

/**
 * The reply for a job in whatever state it is in. A job that is still running is not an error: it
 * comes back with its id and the invitation to wait for it again.
 */
export function jobToolResult(
  jobs: ImageJobs<ImageJobResult>,
  job: ImageJob<ImageJobResult>,
  returnPreview?: boolean,
): ToolResultLike {
  if (job.status === 'running') {
    return {
      content: [
        {
          type: 'text',
          text: `${job.kind === 'edit' ? 'Editing' : 'Generating'} "${job.prompt}" with ${job.model} (${job.size}) is still running after ${elapsedText(job)}. This is normal — pictures often take one to three minutes.\nCall wait_for_image with id "${job.id}" to pick it up; if that call comes back still running, simply call it again. The image is not lost.`,
        },
      ],
      structuredContent: {
        jobId: job.id,
        status: 'running',
        prompt: job.prompt,
        model: job.model,
        size: job.size,
        elapsedSeconds: Math.round((Date.now() - job.startedAt) / 1000),
      },
    };
  }
  jobs.collect(job.id);
  if (job.status === 'error') {
    return {
      content: [{ type: 'text', text: `Error: ${job.error}` }],
      structuredContent: { jobId: job.id, status: 'error', error: job.error },
      isError: true,
    };
  }
  const result = job.result!;
  return {
    content: [{ type: 'text', text: result.text }, ...previewContent(result, returnPreview)],
    structuredContent: { ...result.data, jobId: job.id, status: 'done' },
  };
}
