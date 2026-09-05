// Read and write the IDML zip container.
// Rules from the IDML specification: the first entry must be `mimetype`, stored uncompressed,
// with the exact content `application/vnd.adobe.indesign-idml-package`.
import { strFromU8, strToU8, unzipSync, type Zippable, zipSync } from 'fflate';

export const IDML_MIMETYPE = 'application/vnd.adobe.indesign-idml-package';

/** Ordered map of zip entry name -> bytes. Order is preserved when writing. */
export type PackageParts = Map<string, Uint8Array>;

export function readPackage(bytes: Uint8Array): PackageParts {
  const unzipped = unzipSync(bytes);
  const parts: PackageParts = new Map();
  for (const [name, data] of Object.entries(unzipped)) {
    if (name.endsWith('/')) continue; // directory entries
    parts.set(name, data);
  }
  if (!parts.has('designmap.xml')) {
    throw new Error('Not an IDML package: designmap.xml is missing');
  }
  return parts;
}

export function writePackage(parts: PackageParts): Uint8Array {
  const zippable: Zippable = {};
  // mimetype first and stored (level 0)
  zippable.mimetype = [strToU8(IDML_MIMETYPE), { level: 0 }];
  for (const [name, data] of parts) {
    if (name === 'mimetype') continue;
    zippable[name] = [data, { level: 6 }];
  }
  return zipSync(zippable, { mtime: new Date() });
}

export function partText(parts: PackageParts, name: string): string {
  const data = parts.get(name);
  if (!data) throw new Error(`IDML part not found: ${name}`);
  return strFromU8(data);
}

/** Checks the zip-level rules without parsing any XML. Returns human readable problems. */
export function checkContainer(bytes: Uint8Array): string[] {
  const problems: string[] = [];
  // Local file header of the first entry: signature 0x04034b50, compression method at offset 8,
  // name length at 26, name at 30.
  if (bytes.length < 30 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return ['File is not a zip archive'];
  }
  const method = bytes[8]! | (bytes[9]! << 8);
  const nameLen = bytes[26]! | (bytes[27]! << 8);
  const name = strFromU8(bytes.subarray(30, 30 + nameLen));
  if (name !== 'mimetype') problems.push(`First zip entry is "${name}", expected "mimetype"`);
  else if (method !== 0) problems.push('mimetype entry must be stored uncompressed');
  else {
    const extraLen = bytes[28]! | (bytes[29]! << 8);
    const start = 30 + nameLen + extraLen;
    const content = strFromU8(bytes.subarray(start, start + IDML_MIMETYPE.length));
    if (content !== IDML_MIMETYPE) problems.push(`mimetype content is "${content}"`);
  }
  return problems;
}
