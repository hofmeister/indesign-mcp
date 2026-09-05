// Derivative-based validation of an xmldom tree against a parsed RELAX NG grammar.
import type { Element, Node } from '../idml/xml.ts';
import { datatypeAllows, datatypeEqual } from './datatypes.ts';
import type { Grammar } from './parse.ts';
import { nameClassContains, nameClassToString, type Pattern, type PatternFactory } from './patterns.ts';

export interface RngError {
  message: string;
  /** Path like /Document/Spread[2]/TextFrame */
  path: string;
  line?: number;
}

const WS = /^[ \t\r\n]*$/;

class Validator {
  private f: PatternFactory;
  private nullableMemo = new Map<number, boolean>();
  private startTagMemo = new Map<string, Pattern>();
  private endTagMemo = new Map<number, Pattern>();
  private startTagCloseMemo = new Map<number, Pattern>();
  readonly errors: RngError[] = [];
  maxErrors = 50;

  constructor(grammar: Grammar) {
    this.f = grammar.factory;
  }

  nullable(p: Pattern): boolean {
    switch (p.kind) {
      case 'empty':
      case 'text':
        return true;
      case 'group':
      case 'interleave': {
        let m = this.nullableMemo.get(p.id);
        if (m === undefined) {
          m = this.nullable(p.a) && this.nullable(p.b);
          this.nullableMemo.set(p.id, m);
        }
        return m;
      }
      case 'choice': {
        let m = this.nullableMemo.get(p.id);
        if (m === undefined) {
          m = this.nullable(p.a) || this.nullable(p.b);
          this.nullableMemo.set(p.id, m);
        }
        return m;
      }
      case 'oneOrMore':
        return this.nullable(p.p);
      default:
        return false;
    }
  }

  // ---- text ----------------------------------------------------------------------------------

  textDeriv(p: Pattern, s: string): Pattern {
    const f = this.f;
    switch (p.kind) {
      case 'choice':
        return f.choice(this.textDeriv(p.a, s), this.textDeriv(p.b, s));
      case 'interleave':
        return f.choice(f.interleave(this.textDeriv(p.a, s), p.b), f.interleave(p.a, this.textDeriv(p.b, s)));
      case 'group': {
        const x = f.group(this.textDeriv(p.a, s), p.b);
        return this.nullable(p.a) ? f.choice(x, this.textDeriv(p.b, s)) : x;
      }
      case 'after':
        return f.after(this.textDeriv(p.a, s), p.b);
      case 'oneOrMore':
        return f.group(this.textDeriv(p.p, s), f.choice(p, f.empty));
      case 'text':
        return p;
      case 'value':
        return datatypeEqual(p.dt, p.value, s) ? f.empty : f.notAllowed;
      case 'data':
        if (!datatypeAllows(p.dt, s)) return f.notAllowed;
        if (p.except && this.nullable(this.textDeriv(p.except, s))) return f.notAllowed;
        return f.empty;
      case 'list': {
        const tokens = s.trim() === '' ? [] : s.trim().split(/[ \t\r\n]+/);
        let q = p.p;
        for (const t of tokens) q = this.textDeriv(q, t);
        return this.nullable(q) ? f.empty : f.notAllowed;
      }
      default:
        return f.notAllowed;
    }
  }

  // ---- start tag -----------------------------------------------------------------------------

  startTagOpenDeriv(p: Pattern, ns: string, local: string): Pattern {
    const key = `${p.id}|${ns}|${local}`;
    const memo = this.startTagMemo.get(key);
    if (memo) return memo;
    const f = this.f;
    let r: Pattern;
    switch (p.kind) {
      case 'choice':
        r = f.choice(this.startTagOpenDeriv(p.a, ns, local), this.startTagOpenDeriv(p.b, ns, local));
        break;
      case 'element':
        r = nameClassContains(p.nc, ns, local) ? f.after(p.ref.p ?? f.empty, f.empty) : f.notAllowed;
        break;
      case 'interleave':
        r = f.choice(
          this.applyAfter(this.startTagOpenDeriv(p.a, ns, local), (x) => f.interleave(x, p.b)),
          this.applyAfter(this.startTagOpenDeriv(p.b, ns, local), (x) => f.interleave(p.a, x)),
        );
        break;
      case 'oneOrMore':
        r = this.applyAfter(this.startTagOpenDeriv(p.p, ns, local), (x) => f.group(x, f.choice(p, f.empty)));
        break;
      case 'group': {
        const x = this.applyAfter(this.startTagOpenDeriv(p.a, ns, local), (y) => f.group(y, p.b));
        r = this.nullable(p.a) ? f.choice(x, this.startTagOpenDeriv(p.b, ns, local)) : x;
        break;
      }
      case 'after':
        r = this.applyAfter(this.startTagOpenDeriv(p.a, ns, local), (x) => f.after(x, p.b));
        break;
      default:
        r = f.notAllowed;
    }
    this.startTagMemo.set(key, r);
    return r;
  }

  /** The patterns that follow an element once it is complete (the `b` of every after). */
  afterRest(p: Pattern): Pattern {
    switch (p.kind) {
      case 'after':
        return p.b;
      case 'choice':
        return this.f.choice(this.afterRest(p.a), this.afterRest(p.b));
      default:
        return this.f.notAllowed;
    }
  }

  applyAfter(p: Pattern, fn: (x: Pattern) => Pattern): Pattern {
    switch (p.kind) {
      case 'after':
        return this.f.after(p.a, fn(p.b));
      case 'choice':
        return this.f.choice(this.applyAfter(p.a, fn), this.applyAfter(p.b, fn));
      default:
        return this.f.notAllowed;
    }
  }

  /** `anyValue` consumes the attribute regardless of its value (used to recover after reporting). */
  attDeriv(p: Pattern, ns: string, local: string, value: string, anyValue = false): Pattern {
    const f = this.f;
    switch (p.kind) {
      case 'after':
        return f.after(this.attDeriv(p.a, ns, local, value, anyValue), p.b);
      case 'choice':
        return f.choice(
          this.attDeriv(p.a, ns, local, value, anyValue),
          this.attDeriv(p.b, ns, local, value, anyValue),
        );
      case 'group':
        return f.choice(
          f.group(this.attDeriv(p.a, ns, local, value, anyValue), p.b),
          f.group(p.a, this.attDeriv(p.b, ns, local, value, anyValue)),
        );
      case 'interleave':
        return f.choice(
          f.interleave(this.attDeriv(p.a, ns, local, value, anyValue), p.b),
          f.interleave(p.a, this.attDeriv(p.b, ns, local, value, anyValue)),
        );
      case 'oneOrMore':
        return f.group(this.attDeriv(p.p, ns, local, value, anyValue), f.choice(p, f.empty));
      case 'attribute':
        return nameClassContains(p.nc, ns, local) && (anyValue || this.valueMatch(p.p, value))
          ? f.empty
          : f.notAllowed;
      default:
        return f.notAllowed;
    }
  }

  /** Replaces attribute patterns by empty so validation can continue with the element content. */
  stripAttributes(p: Pattern): Pattern {
    const f = this.f;
    switch (p.kind) {
      case 'attribute':
        return f.empty;
      case 'after':
        return f.after(this.stripAttributes(p.a), p.b);
      case 'choice':
        return f.choice(this.stripAttributes(p.a), this.stripAttributes(p.b));
      case 'group':
        return f.group(this.stripAttributes(p.a), this.stripAttributes(p.b));
      case 'interleave':
        return f.interleave(this.stripAttributes(p.a), this.stripAttributes(p.b));
      case 'oneOrMore':
        return f.oneOrMore(this.stripAttributes(p.p));
      default:
        return p;
    }
  }

  valueMatch(p: Pattern, s: string): boolean {
    return (this.nullable(p) && WS.test(s)) || this.nullable(this.textDeriv(p, s));
  }

  startTagCloseDeriv(p: Pattern): Pattern {
    const memo = this.startTagCloseMemo.get(p.id);
    if (memo) return memo;
    const f = this.f;
    let r: Pattern;
    switch (p.kind) {
      case 'after':
        r = f.after(this.startTagCloseDeriv(p.a), p.b);
        break;
      case 'choice':
        r = f.choice(this.startTagCloseDeriv(p.a), this.startTagCloseDeriv(p.b));
        break;
      case 'group':
        r = f.group(this.startTagCloseDeriv(p.a), this.startTagCloseDeriv(p.b));
        break;
      case 'interleave':
        r = f.interleave(this.startTagCloseDeriv(p.a), this.startTagCloseDeriv(p.b));
        break;
      case 'oneOrMore':
        r = f.oneOrMore(this.startTagCloseDeriv(p.p));
        break;
      case 'attribute':
        r = f.notAllowed;
        break;
      default:
        r = p;
    }
    this.startTagCloseMemo.set(p.id, r);
    return r;
  }

  endTagDeriv(p: Pattern): Pattern {
    const memo = this.endTagMemo.get(p.id);
    if (memo) return memo;
    const f = this.f;
    let r: Pattern;
    switch (p.kind) {
      case 'choice':
        r = f.choice(this.endTagDeriv(p.a), this.endTagDeriv(p.b));
        break;
      case 'after':
        r = this.nullable(p.a) ? p.b : f.notAllowed;
        break;
      default:
        r = f.notAllowed;
    }
    this.endTagMemo.set(p.id, r);
    return r;
  }

  // ---- tree walk -----------------------------------------------------------------------------

  /** Validates `el` against pattern `p` and returns the derivative after its end tag. */
  childDeriv(p: Pattern, el: Element, path: string): Pattern {
    const f = this.f;
    const ns = el.namespaceURI ?? '';
    const local = el.localName ?? el.tagName;
    let q = this.startTagOpenDeriv(p, ns, local);
    if (q.kind === 'notAllowed') {
      this.report(`Element <${local}> is not allowed here${this.expectedElements(p)}`, path, el);
      return f.notAllowed;
    }
    // attributes
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes.item(i)!;
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
      const ans = a.namespaceURI ?? '';
      const alocal = a.localName ?? a.name;
      const next = this.attDeriv(q, ans, alocal, a.value);
      if (next.kind === 'notAllowed') {
        const unknown = !this.attributeAllowed(q, ans, alocal);
        this.report(
          unknown
            ? `Attribute ${a.name} is not allowed on <${local}>`
            : `Attribute ${a.name}="${truncate(a.value)}" has an invalid value on <${local}>${this.expectedValues(q, ans, alocal)}`,
          path,
          el,
        );
        // recover: consume the attribute regardless of its value (or ignore an unknown one)
        if (!unknown) q = this.attDeriv(q, ans, alocal, a.value, true);
        continue;
      }
      q = next;
    }
    let closed = this.startTagCloseDeriv(q);
    if (closed.kind === 'notAllowed') {
      this.report(`<${local}> is missing a required attribute${this.missingAttributes(q)}`, path, el);
      closed = this.startTagCloseDeriv(this.stripAttributes(q));
      if (closed.kind === 'notAllowed') return f.notAllowed;
    }
    q = this.childrenDeriv(closed, el, path);
    if (q.kind === 'notAllowed') return q;
    const end = this.endTagDeriv(q);
    if (end.kind === 'notAllowed') {
      this.report(`<${local}> is incomplete: ${this.expectedContent(q)}`, path, el);
      return f.notAllowed;
    }
    return end;
  }

  private childrenDeriv(p: Pattern, el: Element, path: string): Pattern {
    const f = this.f;
    const nodes: Node[] = [];
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 || n.nodeType === 3 || n.nodeType === 4) nodes.push(n);
    }
    const hasElements = nodes.some((n) => n.nodeType === 1);
    if (!hasElements) {
      const text = nodes.map((n) => n.nodeValue ?? '').join('');
      const q = this.textDeriv(p, text);
      // whitespace-only text can also be ignored entirely
      const r = WS.test(text) ? f.choice(p, q) : q;
      if (r.kind === 'notAllowed') {
        this.report(
          `Text "${truncate(text)}" is not allowed in <${el.localName}>: ${this.expectedContent(p)}`,
          path,
          el,
        );
      }
      return r;
    }
    let q = p;
    const counts = new Map<string, number>();
    for (const n of nodes) {
      if (q.kind === 'notAllowed') return q;
      if (n.nodeType === 1) {
        const c = n as Element;
        const name = c.localName ?? c.tagName;
        const idx = (counts.get(name) ?? 0) + 1;
        counts.set(name, idx);
        const r = this.childDeriv(q, c, `${path}/${name}${idx > 1 ? `[${idx}]` : ''}`);
        if (r.kind === 'notAllowed') {
          // Recover: pretend the element was valid (continue after it) or, if it was not allowed
          // here at all, pretend it was absent. Errors were already reported.
          const rest = this.afterRest(this.startTagOpenDeriv(q, c.namespaceURI ?? '', name));
          q = rest.kind === 'notAllowed' ? q : rest;
        } else q = r;
      } else {
        const text = n.nodeValue ?? '';
        if (WS.test(text)) continue; // whitespace between elements is ignored
        const r = this.textDeriv(q, text);
        if (r.kind === 'notAllowed') {
          this.report(
            `Text "${truncate(text)}" is not allowed between elements in <${el.localName}>`,
            path,
            el,
          );
        }
        q = r;
      }
    }
    return q;
  }

  private report(message: string, path: string, el: Element): void {
    if (this.errors.length >= this.maxErrors) return;
    const line = (el as unknown as { lineNumber?: number }).lineNumber;
    this.errors.push({ message, path, line });
  }

  // ---- diagnostics ---------------------------------------------------------------------------

  private attributeAllowed(p: Pattern, ns: string, local: string): boolean {
    let found = false;
    const walk = (q: Pattern, depth: number) => {
      if (found || depth > 60) return;
      switch (q.kind) {
        case 'attribute':
          if (nameClassContains(q.nc, ns, local)) found = true;
          break;
        case 'choice':
        case 'group':
        case 'interleave':
        case 'after':
          walk(q.a, depth + 1);
          walk(q.b, depth + 1);
          break;
        case 'oneOrMore':
          walk(q.p, depth + 1);
          break;
        default:
      }
    };
    walk(p, 0);
    return found;
  }

  private expectedValues(p: Pattern, ns: string, local: string): string {
    const values = new Set<string>();
    const types = new Set<string>();
    const walk = (q: Pattern, depth: number) => {
      if (depth > 60) return;
      switch (q.kind) {
        case 'attribute':
          if (nameClassContains(q.nc, ns, local)) collectValues(q.p, values, types);
          break;
        case 'choice':
        case 'group':
        case 'interleave':
        case 'after':
          walk(q.a, depth + 1);
          walk(q.b, depth + 1);
          break;
        case 'oneOrMore':
          walk(q.p, depth + 1);
          break;
        default:
      }
    };
    walk(p, 0);
    const parts: string[] = [];
    if (values.size)
      parts.push(`one of: ${[...values].slice(0, 12).join(', ')}${values.size > 12 ? ', …' : ''}`);
    if (types.size) parts.push(`type ${[...types].join(' or ')}`);
    return parts.length ? ` (expected ${parts.join('; ')})` : '';
  }

  private missingAttributes(p: Pattern): string {
    const names = new Set<string>();
    const walk = (q: Pattern, depth: number) => {
      if (depth > 60) return;
      switch (q.kind) {
        case 'attribute':
          names.add(nameClassToString(q.nc));
          break;
        case 'group':
        case 'interleave':
        case 'after':
          walk(q.a, depth + 1);
          walk(q.b, depth + 1);
          break;
        case 'choice':
          walk(q.a, depth + 1);
          break;
        case 'oneOrMore':
          walk(q.p, depth + 1);
          break;
        default:
      }
    };
    walk(p, 0);
    return names.size ? `: ${[...names].slice(0, 8).join(', ')}` : '';
  }

  private expectedElements(p: Pattern): string {
    const names = new Set<string>();
    const walk = (q: Pattern, depth: number) => {
      if (depth > 80 || names.size > 15) return;
      switch (q.kind) {
        case 'element':
          names.add(nameClassToString(q.nc));
          break;
        case 'choice':
        case 'interleave':
          walk(q.a, depth + 1);
          walk(q.b, depth + 1);
          break;
        case 'group':
          walk(q.a, depth + 1);
          if (this.nullable(q.a)) walk(q.b, depth + 1);
          break;
        case 'after':
          walk(q.a, depth + 1);
          break;
        case 'oneOrMore':
          walk(q.p, depth + 1);
          break;
        default:
      }
    };
    walk(p, 0);
    return names.size
      ? ` (expected ${[...names].slice(0, 15).join(', ')}${names.size > 15 ? ', …' : ''})`
      : '';
  }

  private expectedContent(p: Pattern): string {
    const els = this.expectedElements(p);
    if (els) return `missing required content${els.replace(' (expected', ' (expected one of')}`;
    const values = new Set<string>();
    const types = new Set<string>();
    collectValues(p, values, types);
    if (values.size || types.size) {
      return `expected ${[...values].slice(0, 8).join(', ')}${types.size ? ` ${[...types].join('/')}` : ''}`;
    }
    return 'unexpected content';
  }
}

function collectValues(p: Pattern, values: Set<string>, types: Set<string>, depth = 0): void {
  if (depth > 40) return;
  switch (p.kind) {
    case 'value':
      values.add(p.value);
      break;
    case 'data':
      types.add(p.dt.type);
      break;
    case 'text':
      types.add('text');
      break;
    case 'choice':
    case 'group':
    case 'interleave':
    case 'after':
      collectValues(p.a, values, types, depth + 1);
      collectValues(p.b, values, types, depth + 1);
      break;
    case 'oneOrMore':
    case 'list':
      collectValues(p.p, values, types, depth + 1);
      break;
    default:
  }
}

function truncate(s: string, n = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Validates a document's root element against the grammar. */
export function validateElement(
  grammar: Grammar,
  root: Element,
  options: { maxErrors?: number } = {},
): RngError[] {
  const v = new Validator(grammar);
  if (options.maxErrors) v.maxErrors = options.maxErrors;
  const name = root.localName ?? root.tagName;
  const end = v.childDeriv(grammar.start, root, `/${name}`);
  if (end.kind === 'notAllowed' && !v.errors.length) {
    v.errors.push({ message: `Document does not match the schema (root <${name}>)`, path: `/${name}` });
  } else if (end.kind !== 'notAllowed' && !v.nullable(end) && !v.errors.length) {
    v.errors.push({ message: 'Document is incomplete', path: `/${name}` });
  }
  return v.errors;
}
