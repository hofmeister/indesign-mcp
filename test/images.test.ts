import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { IdmlDocument } from '../src/idml/document.ts';
import { imageTransformFor, pathToLinkUri, placedImageInfo, placeImage } from '../src/idml/images.ts';
import { findItem, listItems } from '../src/idml/items.ts';
import { createDocument } from '../src/idml/template.ts';
import { validateDocument } from '../src/idml/validate.ts';
import { probeImage } from '../src/images/files.ts';
import type { EditRequest, GeneratedImage, GenerateRequest, ImageProvider } from '../src/images/provider.ts';
import { pickSize } from '../src/images/provider.ts';
import { decodeRaster, encodePng, thumbnailBase64 } from '../src/images/thumbnail.ts';
import { createServer } from '../src/server.ts';

const MEDIA = join(import.meta.dir, 'fixtures', 'idml', 'media');

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return encodePng({ width, height, data });
}

class FakeProvider implements ImageProvider {
  available = true;
  defaultModel = 'fake-image-1';
  calls: (GenerateRequest | EditRequest)[] = [];
  /** When set, no picture is returned until it resolves — a stand-in for a slow model. */
  gate: Promise<void> | undefined;
  /** When set, requests fail with this message. */
  failWith: string | undefined;
  async generate(req: GenerateRequest): Promise<GeneratedImage> {
    this.calls.push(req);
    await this.gate;
    if (this.failWith) throw new Error(this.failWith);
    const [w, h] = (req.size === 'auto' ? '1024x1024' : req.size).split('x').map(Number) as [number, number];
    return {
      bytes: solidPng(w, h, [255, 128, 0, 255]),
      mimeType: 'image/png',
      width: w,
      height: h,
      model: req.model ?? this.defaultModel,
      revisedPrompt: `revised: ${req.prompt}`,
    };
  }
  async edit(req: EditRequest): Promise<GeneratedImage> {
    this.calls.push(req);
    await this.gate;
    if (this.failWith) throw new Error(this.failWith);
    return {
      bytes: solidPng(256, 256, [0, 128, 255, 255]),
      mimeType: 'image/png',
      width: 256,
      height: 256,
      model: req.model ?? this.defaultModel,
    };
  }
}

describe('image placement', () => {
  test('probe reads dimensions of fixtures', () => {
    const info = probeImage(join(MEDIA, 'default.jpg'));
    expect(info.width).toBeGreaterThan(0);
    expect(info.format).toBe('jpg');
  });

  test('fill and fit transforms', () => {
    const frame = { x: 10, y: 20, width: 100, height: 50 };
    const fill = imageTransformFor(frame, { width: 200, height: 200, ppi: 72 }, 'fill');
    expect(fill.scaleX).toBeCloseTo(0.5);
    expect(fill.matrix[4]).toBeCloseTo(10);
    expect(fill.matrix[5]).toBeCloseTo(20 - 25);
    const fit = imageTransformFor(frame, { width: 200, height: 200, ppi: 72 }, 'fit');
    expect(fit.scaleX).toBeCloseTo(0.25);
    expect(fit.matrix[4]).toBeCloseTo(10 + 25);
    const hi = imageTransformFor(frame, { width: 300, height: 300, ppi: 300 }, 'center');
    expect(hi.scaleX).toBeCloseTo(72 / 300);
  });

  test('link uris', () => {
    expect(pathToLinkUri('/Users/me/My Pics/a b.jpg')).toBe('file:/Users/me/My%20Pics/a%20b.jpg');
    expect(pathToLinkUri('C:\\Users\\me\\a.jpg')).toBe('file:/C:/Users/me/a.jpg');
  });

  test('places an image into a new frame and re-reads it', () => {
    const doc = createDocument({ pageSize: 'A4' });
    const path = join(MEDIA, 'default2.jpg');
    const { frame, info } = placeImage(
      doc,
      { page: 1 },
      { rect: { x: 50, y: 50, width: 200, height: 100 }, name: 'Hero' },
      { path, fit: 'fill' },
    );
    expect(frame.getAttribute('ContentType')).toBe('GraphicType');
    const again = IdmlDocument.fromBytes(doc.toBytes());
    const found = findItem(again, 'Hero');
    expect(found.info.type).toBe('image');
    expect(found.info.imagePath).toBe(path);
    const placed = placedImageInfo(found.element)!;
    expect(placed.widthPx).toBe(info.width);
    expect(placed.effectivePpi).toBeGreaterThan(0);
    expect(validateDocument(again).filter((i) => i.level === 'error')).toEqual([]);
  });

  test('size picking', () => {
    expect(pickSize('gpt-image-1.5', '16:9')).toBe('1536x1024');
    expect(pickSize('gpt-image-1', { width: 100, height: 200 })).toBe('1024x1536');
    expect(pickSize('gpt-image-2', 'square', 'medium')).toBe('1536x1536');
    const wide = pickSize('gpt-image-2', '16:9', 'auto');
    const [w, h] = wide.split('x').map(Number) as [number, number];
    expect(w % 16).toBe(0);
    expect(h % 16).toBe(0);
    expect(w / h).toBeCloseTo(16 / 9, 1);
    expect(pickSize('gpt-image-2', '4000x100')).toMatch(/^\d+x\d+$/);
    expect(() => pickSize('gpt-image-2', 'huge')).toThrow();
  });

  test('thumbnails', () => {
    const png = solidPng(800, 400, [10, 20, 30, 255]);
    const t = thumbnailBase64(png, 'image/png', 200)!;
    expect(t.mimeType).toBe('image/jpeg');
    const raster = decodeRaster(new Uint8Array(Buffer.from(t.data, 'base64')), 'image/jpeg')!;
    expect(raster.width).toBe(200);
    expect(raster.height).toBe(100);
  });
});

describe('image tools', () => {
  let client: Client;
  let dir: string;
  const provider = new FakeProvider();
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as { type: string; text?: string; mimeType?: string }[];
    return {
      text: content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n'),
      images: content.filter((c) => c.type === 'image'),
      data: r.structuredContent as Record<string, unknown> | undefined,
      isError: Boolean(r.isError),
    };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-img-'));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer(loadConfig({ INDESIGN_MCP_DOCUMENTS: dir }), { imageProvider: provider }).connect(st);
    client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
  });

  test('place, generate and edit', async () => {
    const created = await call('new_document', { path: 'pics', pageSize: 'A4' });
    const doc = created.data!.path as string;
    let r = await call('place_image', {
      document: doc,
      image: join(MEDIA, 'bouboune.jpg'),
      page: 1,
      x: 20,
      y: 20,
      width: 80,
      name: 'Photo',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Photo');
    r = await call('generate_image', {
      document: doc,
      prompt: 'A red bicycle on a beach',
      page: 1,
      x: 20,
      y: 120,
      width: 100,
      height: 60,
      name: 'Bike',
    });
    expect(r.isError).toBe(false);
    expect(r.images.length).toBe(1);
    expect(existsSync(r.data!.path as string)).toBe(true);
    expect((r.data!.path as string).includes(join(dir, 'Links'))).toBe(true);
    const lastCall = provider.calls.at(-1)!;
    const [w, h] = lastCall.size.split('x').map(Number) as [number, number];
    expect(w / h).toBeCloseTo(100 / 60, 0);
    r = await call('generate_image', {
      document: doc,
      prompt: 'A logo',
      frame: 'Photo',
      transparentBackground: true,
      returnPreview: false,
    });
    expect(r.isError).toBe(false);
    expect(r.images.length).toBe(0);
    expect(provider.calls.at(-1)!.background).toBe('transparent');
    r = await call('edit_image', { document: doc, prompt: 'make it night', images: ['Bike'] });
    expect(r.isError).toBe(false);
    expect((provider.calls.at(-1) as EditRequest).images.length).toBe(1);
    r = await call('set_image_fit', { document: doc, frame: 'Bike', fit: 'fit' });
    expect(r.isError).toBe(false);
    r = await call('list', { what: 'images', document: doc });
    expect(r.data!.images).toHaveLength(2);
    const reopened = IdmlDocument.load(doc);
    expect(listItems(reopened).filter((i) => i.type === 'image')).toHaveLength(2);
    expect(validateDocument(reopened).filter((i) => i.level === 'error')).toEqual([]);
  });

  test('reports missing API key nicely', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer(loadConfig({ INDESIGN_MCP_DOCUMENTS: dir, OPENAI_API_KEY: '' })).connect(st);
    const c = new Client({ name: 't2', version: '0' });
    await c.connect(ct);
    const created = await c.callTool({ name: 'new_document', arguments: { path: 'nokey' } });
    const path = (created.structuredContent as { path: string }).path;
    const r = await c.callTool({ name: 'generate_image', arguments: { document: path, prompt: 'anything' } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toContain('OPENAI_API_KEY');
  });
});

/** A client on any server, with the same reply shredder the other suites use. */
async function connect(server: import('@modelcontextprotocol/server').McpServer) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as { type: string; text?: string }[];
    return {
      text: content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n'),
      images: content.filter((c) => c.type === 'image'),
      data: (r.structuredContent ?? {}) as Record<string, unknown>,
      isError: Boolean(r.isError),
    };
  };
}

describe('image jobs', () => {
  test('a slow generation returns a job id and wait_for_image collects it', async () => {
    let release!: () => void;
    const provider = new FakeProvider();
    provider.gate = new Promise<void>((r) => {
      release = r;
    });
    const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-job-'));
    const call = await connect(
      createServer(loadConfig({ INDESIGN_MCP_DOCUMENTS: dir }), { imageProvider: provider }),
    );
    const doc = (await call('new_document', { path: 'jobs', pageSize: 'A4' })).data.path as string;

    const started = await call('generate_image', {
      document: doc,
      prompt: 'A slow horse',
      waitSeconds: 0,
      page: 1,
      x: 10,
      y: 10,
      width: 60,
      name: 'Horse',
    });
    expect(started.isError).toBe(false);
    expect(started.data.status).toBe('running');
    const id = started.data.jobId as string;
    expect(id).toBeTruthy();
    expect(started.text).toContain('wait_for_image');

    // Still running: the tool says so instead of failing, and the job survives the wait.
    const early = await call('wait_for_image', { id, waitSeconds: 0 });
    expect(early.isError).toBe(false);
    expect(early.data.status).toBe('running');
    expect((await call('list', { what: 'image_jobs' })).text).toContain('running');

    release();
    const done = await call('wait_for_image', { id });
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('done');
    expect(existsSync(done.data.path as string)).toBe(true);
    expect(done.images.length).toBe(1);
    expect(provider.calls).toHaveLength(1);
    // The placement the generating call asked for happened when the picture arrived.
    expect(listItems(IdmlDocument.load(doc)).filter((i) => i.name === 'Horse')).toHaveLength(1);
    // Collecting twice is harmless: the result is kept, not regenerated.
    const again = await call('wait_for_image', { id });
    expect(again.data.path).toBe(done.data.path);
    expect(provider.calls).toHaveLength(1);
  });

  test('a failed generation is reported once, by whoever collects it', async () => {
    const provider = new FakeProvider();
    provider.failWith = 'OpenAI rate limit or quota reached (429).';
    const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-job-'));
    const call = await connect(
      createServer(loadConfig({ INDESIGN_MCP_DOCUMENTS: dir }), { imageProvider: provider }),
    );
    const doc = (await call('new_document', { path: 'fails', pageSize: 'A4' })).data.path as string;
    const r = await call('generate_image', { document: doc, prompt: 'A doomed horse' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('429');
  });

  test('wait_for_image without an id takes the job that is running', async () => {
    let release!: () => void;
    const provider = new FakeProvider();
    provider.gate = new Promise<void>((r) => {
      release = r;
    });
    const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-job-'));
    const call = await connect(
      createServer(loadConfig({ INDESIGN_MCP_DOCUMENTS: dir }), { imageProvider: provider }),
    );
    const doc = (await call('new_document', { path: 'bare', pageSize: 'A4' })).data.path as string;
    const started = await call('generate_image', { document: doc, prompt: 'A horse', waitSeconds: 0 });
    release();
    const done = await call('wait_for_image', {});
    expect(done.data.jobId).toBe(started.data.jobId);
    expect(done.data.status).toBe('done');
  });
});

describe('standalone image server', () => {
  test('generates, edits and waits without any document', async () => {
    const { createImageServer, loadImageConfig } = await import('../src/images/server.ts');
    let release!: () => void;
    const provider = new FakeProvider();
    const out = mkdtempSync(join(tmpdir(), 'image-mcp-out-'));
    const call = await connect(
      createImageServer(loadImageConfig({ OPENAI_API_KEY: 'k', IMAGE_MCP_OUTPUT: out }), {
        imageProvider: provider,
      }),
    );
    const info = await call('server_info');
    expect(info.data.outputDir).toBe(out);

    let r = await call('generate_image', { prompt: 'A red bicycle', size: '16:9' });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe('done');
    const path = r.data.path as string;
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(out)).toBe(true);
    expect(r.images.length).toBe(1);

    r = await call('edit_image', { prompt: 'make it night', images: [path], returnPreview: false });
    expect(r.isError).toBe(false);
    expect(existsSync(r.data.path as string)).toBe(true);
    expect(r.images.length).toBe(0);
    expect((provider.calls.at(-1) as EditRequest).images).toHaveLength(1);

    provider.gate = new Promise<void>((res) => {
      release = res;
    });
    const started = await call('generate_image', { prompt: 'A slow bicycle', waitSeconds: 0 });
    expect(started.data.status).toBe('running');
    expect((await call('list_image_jobs')).text).toContain(started.data.jobId as string);
    release();
    const done = await call('wait_for_image', { id: started.data.jobId as string });
    expect(done.data.status).toBe('done');
    expect(existsSync(done.data.path as string)).toBe(true);
  });

  test('reports a missing API key nicely', async () => {
    const { createImageServer, loadImageConfig } = await import('../src/images/server.ts');
    const call = await connect(createImageServer(loadImageConfig({ OPENAI_API_KEY: '' })));
    const r = await call('generate_image', { prompt: 'anything' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('OPENAI_API_KEY');
  });
});
