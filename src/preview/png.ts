// SVG → PNG with resvg (WebAssembly), no native dependencies.
import { readFileSync } from 'node:fs';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import wasmPath from '../../node_modules/@resvg/resvg-wasm/index_bg.wasm' with { type: 'file' };

let ready: Promise<void> | undefined;

export function ensureResvg(): Promise<void> {
  ready ??= initWasm(new Uint8Array(readFileSync(wasmPath)).buffer as ArrayBuffer).catch((e: unknown) => {
    // initWasm throws if called twice in the same process (e.g. tests); that is fine
    if (!String(e).includes('Already initialized')) throw e;
  });
  return ready;
}

export interface RasterOptions {
  /** Output width in pixels (height follows the aspect ratio). */
  width?: number;
  /** Alternatively dots per inch relative to the SVG's point size. */
  dpi?: number;
  background?: string;
}

export async function svgToPng(
  svg: string,
  options: RasterOptions = {},
): Promise<{ png: Uint8Array; width: number; height: number }> {
  await ensureResvg();
  const fitTo = options.width
    ? { mode: 'width' as const, value: Math.round(options.width) }
    : options.dpi
      ? { mode: 'zoom' as const, value: options.dpi / 72 }
      : { mode: 'original' as const };
  const resvg = new Resvg(svg, {
    fitTo,
    background: options.background ?? 'rgba(255,255,255,1)',
    font: { loadSystemFonts: false },
    shapeRendering: 2,
    textRendering: 2,
    imageRendering: 0,
  });
  const rendered = resvg.render();
  const png = rendered.asPng();
  const out = { png, width: rendered.width, height: rendered.height };
  rendered.free();
  resvg.free();
  return out;
}
