// Image generation abstraction so the OpenAI client can be swapped for a fake in tests.
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto';
export type ImageBackground = 'transparent' | 'opaque' | 'auto';
export type ImageFormat = 'png' | 'jpeg' | 'webp';

export interface GenerateRequest {
  prompt: string;
  /** "WIDTHxHEIGHT" in pixels or "auto". */
  size: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  outputFormat?: ImageFormat;
  model?: string;
}

export interface InputImage {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}

export interface EditRequest extends GenerateRequest {
  images: InputImage[];
  /** PNG with transparent areas marking what to change. */
  mask?: InputImage;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  model: string;
  revisedPrompt?: string;
}

export interface ImageProvider {
  readonly available: boolean;
  /** Human-readable reason when not available (e.g. missing API key). */
  readonly unavailableReason?: string;
  generate(req: GenerateRequest): Promise<GeneratedImage>;
  edit(req: EditRequest): Promise<GeneratedImage>;
}

/** Size rules per model family. */
export interface SizeRules {
  fixed?: string[];
  maxEdge?: number;
  multipleOf?: number;
  maxAspect?: number;
  minPixels?: number;
  maxPixels?: number;
}

export function sizeRulesFor(model: string): SizeRules {
  if (model.startsWith('gpt-image-2')) {
    return { maxEdge: 3840, multipleOf: 16, maxAspect: 3, minPixels: 655_360, maxPixels: 8_294_400 };
  }
  // gpt-image-1, gpt-image-1-mini, gpt-image-1.5
  return { fixed: ['1024x1024', '1536x1024', '1024x1536'] };
}

/**
 * Picks a valid size for the model that best matches the wanted aspect ratio (width/height).
 * `target` may be an explicit "WxH", an aspect like "16:9", or a {width,height} in any unit.
 */
export function pickSize(
  model: string,
  target: string | { width: number; height: number } | undefined,
  quality: ImageQuality = 'auto',
): string {
  const rules = sizeRulesFor(model);
  let aspect: number | undefined;
  let explicit: { w: number; h: number } | undefined;
  if (typeof target === 'string') {
    const t = target.trim().toLowerCase();
    if (t === 'auto' || t === '') return rules.fixed ? 'auto' : defaultSize(rules, 1, quality);
    let m = /^(\d+)\s*x\s*(\d+)$/.exec(t);
    if (m) explicit = { w: Number(m[1]), h: Number(m[2]) };
    else {
      m = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(t);
      if (m) aspect = Number(m[1]) / Number(m[2]);
      else if (t === 'square') aspect = 1;
      else if (t === 'landscape') aspect = 3 / 2;
      else if (t === 'portrait') aspect = 2 / 3;
      else
        throw new Error(
          `Cannot understand image size "${target}". Use "1024x1024", an aspect like "16:9", or "square"/"landscape"/"portrait".`,
        );
    }
  } else if (target) {
    aspect = target.width / target.height;
  }
  if (rules.fixed) {
    if (explicit) {
      const exact = rules.fixed.find((s) => s === `${explicit!.w}x${explicit!.h}`);
      if (exact) return exact;
      aspect = explicit.w / explicit.h;
    }
    if (aspect === undefined) return '1024x1024';
    return aspect > 1.15 ? '1536x1024' : aspect < 0.87 ? '1024x1536' : '1024x1024';
  }
  if (explicit) return clampSize(rules, explicit.w, explicit.h);
  return defaultSize(rules, aspect ?? 1, quality);
}

function defaultSize(rules: SizeRules, aspect: number, quality: ImageQuality): string {
  // target ~1.5–2 MP for medium/auto, ~4 MP for high, ~1 MP for low
  const targetPixels = quality === 'high' ? 4_194_304 : quality === 'low' ? 1_048_576 : 2_359_296;
  const h = Math.sqrt(targetPixels / aspect);
  const w = h * aspect;
  return clampSize(rules, w, h);
}

function clampSize(rules: SizeRules, w: number, h: number): string {
  const step = rules.multipleOf ?? 16;
  const maxEdge = rules.maxEdge ?? 3840;
  const maxAspect = rules.maxAspect ?? 3;
  let aspect = w / h;
  if (aspect > maxAspect) aspect = maxAspect;
  if (aspect < 1 / maxAspect) aspect = 1 / maxAspect;
  let width = Math.max(w, h * aspect);
  let height = width / aspect;
  if (aspect >= 1 && width !== w) {
    width = w;
    height = w / aspect;
  }
  // scale into pixel budget
  const px = width * height;
  const minPx = rules.minPixels ?? 0;
  const maxPx = rules.maxPixels ?? Number.POSITIVE_INFINITY;
  if (px < minPx) {
    const f = Math.sqrt(minPx / px);
    width *= f;
    height *= f;
  } else if (px > maxPx) {
    const f = Math.sqrt(maxPx / px);
    width *= f;
    height *= f;
  }
  const longest = Math.max(width, height);
  if (longest > maxEdge) {
    const f = maxEdge / longest;
    width *= f;
    height *= f;
  }
  const rw = Math.max(step, Math.round(width / step) * step);
  const rh = Math.max(step, Math.round(height / step) * step);
  // rounding may push pixels below the minimum; nudge up
  let fw = rw;
  let fh = rh;
  while (fw * fh < minPx) {
    if (fw / fh >= 1) fh += step;
    else fw += step;
  }
  return `${fw}x${fh}`;
}
