// Saving generated images next to the document and probing image files.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { imageSize } from 'image-size';

export interface ImageFileInfo {
  path: string;
  width: number;
  height: number;
  /** Pixels per inch, if the file declares it (defaults to 72). */
  ppi: number;
  format: string;
  mimeType: string;
  bytes: number;
}

export function imageDimensions(bytes: Uint8Array): { width: number; height: number; type?: string } | undefined {
  try {
    const r = imageSize(bytes);
    if (!r.width || !r.height) return undefined;
    return { width: r.width, height: r.height, type: r.type };
  } catch {
    return undefined;
  }
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
  psd: 'image/vnd.adobe.photoshop',
  pdf: 'application/pdf',
  ai: 'application/pdf',
  eps: 'application/postscript',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

/** InDesign's LinkResourceFormat / ImageTypeName names. */
export const INDESIGN_FORMAT: Record<string, string> = {
  png: '$ID/Portable Network Graphics (PNG)',
  jpg: '$ID/JPEG',
  jpeg: '$ID/JPEG',
  gif: '$ID/GIF',
  tif: '$ID/TIFF',
  tiff: '$ID/TIFF',
  psd: '$ID/Photoshop',
  pdf: '$ID/Adobe Portable Document Format (PDF)',
  ai: '$ID/Adobe Portable Document Format (PDF)',
  eps: '$ID/EPS',
  bmp: '$ID/Windows Bitmap',
  webp: '$ID/WebP',
};

export function probeImage(path: string): ImageFileInfo {
  if (!existsSync(path)) throw new Error(`Image file not found: ${path}`);
  const bytes = readFileSync(path);
  const ext = extname(path).slice(1).toLowerCase();
  const dims = imageDimensions(new Uint8Array(bytes));
  if (!dims) {
    if (ext === 'pdf' || ext === 'ai' || ext === 'eps' || ext === 'psd') {
      // Vector / layered formats: use a nominal size; InDesign reads the real one when relinking.
      return { path, width: 612, height: 792, ppi: 72, format: ext, mimeType: MIME[ext] ?? 'application/octet-stream', bytes: bytes.length };
    }
    throw new Error(`Cannot read image dimensions of ${basename(path)} (${ext || 'unknown format'}). Supported: PNG, JPEG, GIF, TIFF, WebP, BMP.`);
  }
  return {
    path,
    width: dims.width,
    height: dims.height,
    ppi: readPpi(new Uint8Array(bytes), dims.type ?? ext) ?? 72,
    format: dims.type ?? ext,
    mimeType: MIME[dims.type ?? ext] ?? 'application/octet-stream',
    bytes: bytes.length,
  };
}

/** Reads the physical resolution from PNG pHYs or JPEG JFIF/EXIF headers, if any. */
export function readPpi(bytes: Uint8Array, type: string): number | undefined {
  try {
    if (type === 'png') {
      let off = 8;
      while (off + 8 <= bytes.length) {
        const len = (bytes[off]! << 24) | (bytes[off + 1]! << 16) | (bytes[off + 2]! << 8) | bytes[off + 3]!;
        const kind = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
        if (kind === 'pHYs') {
          const x = ((bytes[off + 8]! << 24) | (bytes[off + 9]! << 16) | (bytes[off + 10]! << 8) | bytes[off + 11]!) >>> 0;
          const unit = bytes[off + 16];
          if (unit === 1 && x > 0) return Math.round(x * 0.0254);
          return undefined;
        }
        if (kind === 'IDAT' || kind === 'IEND') return undefined;
        off += 12 + len;
      }
    } else if (type === 'jpg' || type === 'jpeg') {
      let off = 2;
      while (off + 4 <= bytes.length && bytes[off] === 0xff) {
        const marker = bytes[off + 1]!;
        const len = (bytes[off + 2]! << 8) | bytes[off + 3]!;
        if (marker === 0xe0 && bytes[off + 4] === 0x4a && bytes[off + 5] === 0x46) {
          const units = bytes[off + 11];
          const xd = (bytes[off + 12]! << 8) | bytes[off + 13]!;
          if (units === 1 && xd > 1) return xd;
          if (units === 2 && xd > 1) return Math.round(xd * 2.54);
          return undefined;
        }
        if (marker === 0xda) break;
        off += 2 + len;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Turns a prompt into a short file-name slug. */
export function slugify(s: string, max = 40): string {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || 'image';
}

/** Writes image bytes into `dir` with a unique name; returns the path. */
export function saveImage(dir: string, baseName: string, ext: string, bytes: Uint8Array): string {
  let candidate = join(dir, `${baseName}.${ext}`);
  let n = 2;
  while (existsSync(candidate)) candidate = join(dir, `${baseName}-${n++}.${ext}`);
  writeFileSync(candidate, bytes);
  return candidate;
}

export function mimeFor(path: string): string {
  return MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

export function indesignFormatFor(path: string): string {
  return INDESIGN_FORMAT[extname(path).slice(1).toLowerCase()] ?? '$ID/JPEG';
}
