// Small previews of generated images for the chat, without native dependencies.
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export interface Raster {
  width: number;
  height: number;
  /** RGBA */
  data: Uint8Array;
}

export function decodeRaster(bytes: Uint8Array, mimeType: string): Raster | undefined {
  try {
    if (mimeType === 'image/png') {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    }
    if (mimeType === 'image/jpeg') {
      const img = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
      return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Box-filter downscale to fit within maxEdge pixels. */
export function downscale(src: Raster, maxEdge: number): Raster {
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  if (scale >= 1) return src;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y / h) * src.height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) / h) * src.height));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x / w) * src.width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) / w) * src.width));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i]!;
          g += src.data[i + 1]!;
          b += src.data[i + 2]!;
          a += src.data[i + 3]!;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

export function encodePng(r: Raster): Uint8Array {
  const png = new PNG({ width: r.width, height: r.height });
  png.data = Buffer.from(r.data);
  return new Uint8Array(PNG.sync.write(png));
}

export function encodeJpeg(r: Raster, quality = 80): Uint8Array {
  return new Uint8Array(
    jpeg.encode({ width: r.width, height: r.height, data: Buffer.from(r.data) }, quality).data,
  );
}

/** PNG thumbnail (as base64) of an image, or undefined if the format cannot be decoded. */
export function thumbnailBase64(
  bytes: Uint8Array,
  mimeType: string,
  maxEdge = 512,
): { data: string; mimeType: string } | undefined {
  const raster = decodeRaster(bytes, mimeType);
  if (!raster) return undefined;
  const small = downscale(raster, maxEdge);
  // JPEG keeps the payload small; PNG when the image has transparency
  const hasAlpha = mimeType === 'image/png' && hasTransparency(small);
  const encoded = hasAlpha ? encodePng(small) : encodeJpeg(small, 78);
  return { data: Buffer.from(encoded).toString('base64'), mimeType: hasAlpha ? 'image/png' : 'image/jpeg' };
}

function hasTransparency(r: Raster): boolean {
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i]! < 250) return true;
  return false;
}
