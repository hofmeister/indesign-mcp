// The subset of XML Schema datatypes used by IDML schemas (and the built-in string/token).
import type { Datatype } from './patterns.ts';

const INT_RANGES: Record<string, [number, number]> = {
  byte: [-128, 127],
  short: [-32768, 32767],
  int: [-2147483648, 2147483647],
  long: [-(2 ** 63), 2 ** 63],
  unsignedByte: [0, 255],
  unsignedShort: [0, 65535],
  unsignedInt: [0, 4294967295],
  unsignedLong: [0, 2 ** 64],
  nonNegativeInteger: [0, Number.POSITIVE_INFINITY],
  positiveInteger: [1, Number.POSITIVE_INFINITY],
  nonPositiveInteger: [Number.NEGATIVE_INFINITY, 0],
  negativeInteger: [Number.NEGATIVE_INFINITY, -1],
  integer: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
};

function collapse(s: string): string {
  return s.replace(/[ \t\r\n]+/g, ' ').trim();
}

/** Does `s` belong to the datatype's value space (with facets)? */
export function datatypeAllows(dt: Datatype, s: string): boolean {
  const t = dt.type;
  if (dt.library === '' || dt.library === undefined) return true; // RELAX NG built-in string/token
  const v = t === 'string' ? s : collapse(s);
  if (
    t === 'string' ||
    t === 'token' ||
    t === 'normalizedString' ||
    t === 'NMTOKEN' ||
    t === 'Name' ||
    t === 'NCName' ||
    t === 'anyURI' ||
    t === 'language' ||
    t === 'ID' ||
    t === 'IDREF'
  ) {
    return facetsOk(dt, v, undefined);
  }
  if (t === 'boolean') return ['true', 'false', '1', '0'].includes(v);
  if (t === 'double' || t === 'float' || t === 'decimal') {
    if (v === 'INF' || v === '-INF' || v === 'NaN') return t !== 'decimal';
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return false;
    return facetsOk(dt, v, Number(v));
  }
  if (t in INT_RANGES) {
    if (!/^[+-]?\d+$/.test(v)) return false;
    const n = Number(v);
    const [lo, hi] = INT_RANGES[t]!;
    if (n < lo || n > hi) return false;
    return facetsOk(dt, v, n);
  }
  if (t === 'dateTime') return /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(v);
  if (t === 'date') return /^-?\d{4,}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/.test(v);
  if (t === 'time') return /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(v);
  if (t === 'hexBinary') return /^([0-9a-fA-F]{2})*$/.test(v);
  if (t === 'base64Binary') return /^[A-Za-z0-9+/=\s]*$/.test(v);
  // unknown type: be permissive
  return true;
}

function facetsOk(dt: Datatype, v: string, n: number | undefined): boolean {
  for (const [name, param] of Object.entries(dt.params)) {
    switch (name) {
      case 'minInclusive':
        if (n === undefined || n < Number(param)) return false;
        break;
      case 'maxInclusive':
        if (n === undefined || n > Number(param)) return false;
        break;
      case 'minExclusive':
        if (n === undefined || n <= Number(param)) return false;
        break;
      case 'maxExclusive':
        if (n === undefined || n >= Number(param)) return false;
        break;
      case 'length':
        if (v.length !== Number(param)) return false;
        break;
      case 'minLength':
        if (v.length < Number(param)) return false;
        break;
      case 'maxLength':
        if (v.length > Number(param)) return false;
        break;
      case 'pattern':
        try {
          if (!new RegExp(`^(?:${param})$`, 'u').test(v)) return false;
        } catch {
          // unsupported XSD regex syntax: ignore the facet
        }
        break;
      default:
        break;
    }
  }
  return true;
}

/** Are the two lexical values equal in the datatype's value space? */
export function datatypeEqual(dt: Datatype, a: string, b: string): boolean {
  const t = dt.type;
  // RELAX NG built-ins: "string" compares verbatim, "token" (the default for <value>) collapses whitespace
  if (dt.library === '') return t === 'string' ? a === b : collapse(a) === collapse(b);
  if (t === 'string') return a === b;
  const ca = collapse(a);
  const cb = collapse(b);
  if (t === 'boolean') return ['true', '1'].includes(ca) === ['true', '1'].includes(cb);
  if (t === 'double' || t === 'float' || t === 'decimal' || t in INT_RANGES) return Number(ca) === Number(cb);
  return ca === cb;
}
