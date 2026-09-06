import OpenAI, { toFile } from 'openai';
import { imageDimensions } from './files.ts';
import type { EditRequest, GeneratedImage, GenerateRequest, ImageProvider } from './provider.ts';

export class OpenAIImageProvider implements ImageProvider {
  private client: OpenAI | undefined;
  readonly available: boolean;
  readonly unavailableReason: string | undefined;
  readonly defaultModel: string;

  constructor(
    private apiKey: string | undefined,
    defaultModel = 'gpt-image-2',
  ) {
    this.available = Boolean(apiKey);
    this.defaultModel = defaultModel;
    this.unavailableReason = apiKey
      ? undefined
      : 'Image generation needs an OpenAI API key. Set the OPENAI_API_KEY environment variable (or the "OpenAI API key" field in the Claude Desktop extension settings) and restart Claude.';
  }

  private getClient(): OpenAI {
    if (!this.apiKey) throw new Error(this.unavailableReason);
    this.client ??= new OpenAI({ apiKey: this.apiKey });
    return this.client;
  }

  private common(req: GenerateRequest) {
    const model = req.model ?? this.defaultModel;
    const params: Record<string, unknown> = { model, prompt: req.prompt, n: 1 };
    if (req.size && req.size !== 'auto') params.size = req.size;
    if (req.quality && req.quality !== 'auto') params.quality = req.quality;
    if (req.background && req.background !== 'auto') params.background = req.background;
    if (req.outputFormat) params.output_format = req.outputFormat;
    if (req.outputFormat === 'jpeg' || req.outputFormat === 'webp') params.output_compression = 90;
    return { model, params };
  }

  private toImage(
    data: { b64_json?: string; revised_prompt?: string } | undefined,
    model: string,
    format: string,
  ): GeneratedImage {
    if (!data?.b64_json) throw new Error('OpenAI returned no image data');
    const bytes = new Uint8Array(Buffer.from(data.b64_json, 'base64'));
    const dims = imageDimensions(bytes);
    return {
      bytes,
      mimeType: format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png',
      width: dims?.width ?? 0,
      height: dims?.height ?? 0,
      model,
      revisedPrompt: data.revised_prompt,
    };
  }

  async generate(req: GenerateRequest): Promise<GeneratedImage> {
    const client = this.getClient();
    const { model, params } = this.common(req);
    const res = await wrap(() =>
      client.images.generate(params as unknown as Parameters<typeof client.images.generate>[0]),
    );
    return this.toImage(
      (res as { data?: { b64_json?: string; revised_prompt?: string }[] }).data?.[0],
      model,
      req.outputFormat ?? 'png',
    );
  }

  async edit(req: EditRequest): Promise<GeneratedImage> {
    const client = this.getClient();
    const { model, params } = this.common(req);
    const files = await Promise.all(
      req.images.map((img) => toFile(Buffer.from(img.bytes), img.name, { type: img.mimeType })),
    );
    params.image = files.length === 1 ? files[0] : files;
    if (req.mask)
      params.mask = await toFile(Buffer.from(req.mask.bytes), req.mask.name, { type: req.mask.mimeType });
    const res = await wrap(() =>
      client.images.edit(params as unknown as Parameters<typeof client.images.edit>[0]),
    );
    return this.toImage(
      (res as { data?: { b64_json?: string; revised_prompt?: string }[] }).data?.[0],
      model,
      req.outputFormat ?? 'png',
    );
  }
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { status?: number; message?: string; error?: { message?: string } };
    const detail = e.error?.message ?? e.message ?? String(err);
    if (e.status === 401)
      throw new Error(`OpenAI rejected the API key (401). Check OPENAI_API_KEY. ${detail}`);
    if (e.status === 429) throw new Error(`OpenAI rate limit or quota reached (429). ${detail}`);
    if (e.status === 400) throw new Error(`OpenAI could not process the request: ${detail}`);
    throw new Error(`OpenAI image request failed: ${detail}`);
  }
}
