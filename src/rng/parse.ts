// Parses RELAX NG (XML syntax) into hash-consed patterns, resolving <include>, <ref> and shorthands.
import { children, type Document, type Element, parseXml } from '../idml/xml.ts';
import { type Datatype, type ElementRef, type NameClass, type Pattern, PatternFactory } from './patterns.ts';

const RNG_NS = 'http://relaxng.org/ns/structure/1.0';

export interface Grammar {
  factory: PatternFactory;
  start: Pattern;
}

export type SchemaLoader = (href: string, fromUrl: string) => string;

interface DefineEntry {
  el: Element;
  combine?: string;
  /** Extra definitions with the same name combined via `combine`. */
  extra: Element[];
  pattern?: Pattern;
  /** Lazily resolved element content for single-element definitions. */
  refs: ElementRef[];
}

interface Scope {
  ns: string;
  datatypeLibrary: string;
  defines: Map<string, DefineEntry>;
}

/**
 * Parses an RNG document. `loader` returns the text of included schemas (href relative to `url`).
 */
export function parseGrammar(text: string, url: string, loader: SchemaLoader): Grammar {
  const factory = new PatternFactory();
  const doc = parseXml(text, url);
  const root = doc.documentElement!;
  const defines = new Map<string, DefineEntry>();
  let startEl: Element | undefined;

  const collect = (grammarEl: Element, fromUrl: string) => {
    for (const c of children(grammarEl)) {
      if (c.namespaceURI !== RNG_NS && c.namespaceURI !== null) continue;
      switch (c.localName) {
        case 'start':
          startEl ??= c;
          break;
        case 'define': {
          const name = c.getAttribute('name') ?? '';
          const existing = defines.get(name);
          const combine = c.getAttribute('combine') ?? undefined;
          if (existing) {
            existing.extra.push(c);
            existing.combine ??= combine;
          } else defines.set(name, { el: c, combine, extra: [], refs: [] });
          break;
        }
        case 'include': {
          const href = c.getAttribute('href') ?? '';
          const includedText = loader(href, fromUrl);
          const incDoc: Document = parseXml(includedText, href);
          // Definitions inside <include> override the included grammar's
          const overrides = new Set(
            children(c)
              .filter((x) => x.localName === 'define')
              .map((x) => x.getAttribute('name')),
          );
          const incRoot = incDoc.documentElement!;
          const filtered = incDoc.createElement('grammar');
          for (const ic of children(incRoot)) {
            if (ic.localName === 'define' && overrides.has(ic.getAttribute('name'))) continue;
            filtered.appendChild(ic);
          }
          collect(filtered, resolveUrl(href, fromUrl));
          collect(c, fromUrl);
          break;
        }
        case 'div':
          collect(c, fromUrl);
          break;
        default:
          break;
      }
    }
  };

  if (root.localName !== 'grammar') {
    // A pattern as the root: wrap it
    const scope: Scope = {
      ns: root.getAttribute('ns') ?? '',
      datatypeLibrary: root.getAttribute('datatypeLibrary') ?? '',
      defines,
    };
    const start = buildPattern(factory, root, scope);
    return { factory, start };
  }
  collect(root, url);
  if (!startEl) throw new Error(`RELAX NG grammar in ${url} has no <start>`);
  const scope: Scope = {
    ns: root.getAttribute('ns') ?? '',
    datatypeLibrary: root.getAttribute('datatypeLibrary') ?? '',
    defines,
  };
  const start = buildChildren(factory, startEl, scope);
  // resolve all lazily referenced element contents (new refs may appear while resolving)
  let pending = true;
  while (pending) {
    pending = false;
    for (const d of defines.values()) {
      for (const ref of d.refs) {
        if (!ref.p) {
          ref.p = elementContentOf(factory, d, scope);
          pending = true;
        }
      }
    }
  }
  return { factory, start };
}

function resolveUrl(href: string, fromUrl: string): string {
  if (/^[a-z]+:/i.test(href) || href.startsWith('/')) return href;
  const base = fromUrl.includes('/') ? fromUrl.slice(0, fromUrl.lastIndexOf('/') + 1) : '';
  const parts = `${base}${href}`.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  }
  return out.join('/');
}

function scopeFor(el: Element, parent: Scope): Scope {
  const ns = el.hasAttribute('ns') ? el.getAttribute('ns')! : parent.ns;
  const dl = el.hasAttribute('datatypeLibrary')
    ? el.getAttribute('datatypeLibrary')!
    : parent.datatypeLibrary;
  return ns === parent.ns && dl === parent.datatypeLibrary ? parent : { ...parent, ns, datatypeLibrary: dl };
}

/** Content pattern of a definition that consists of exactly one <element>. */
function elementContentOf(factory: PatternFactory, d: DefineEntry, scope: Scope): Pattern {
  const elEl = children(d.el).find((c) => c.localName === 'element')!;
  const elScope = scopeFor(elEl, scopeFor(d.el, scope));
  return buildChildren(factory, elEl, elScope);
}

function definePattern(factory: PatternFactory, d: DefineEntry, scope: Scope): Pattern {
  if (d.pattern) return d.pattern;
  let p = buildChildren(factory, d.el, scopeFor(d.el, scope));
  for (const extra of d.extra) {
    const q = buildChildren(factory, extra, scopeFor(extra, scope));
    p = d.combine === 'interleave' ? factory.interleave(p, q) : factory.choice(p, q);
  }
  d.pattern = p;
  return p;
}

function isNameClassChild(c: Element): boolean {
  const parent = c.parentNode as Element | null;
  if (!parent || !['element', 'attribute'].includes(parent.localName ?? '')) return false;
  if (['name', 'anyName', 'nsName'].includes(c.localName ?? '')) return true;
  // a <choice> that is the first child of a nameless element/attribute is a name class
  return c.localName === 'choice' && !parent.hasAttribute('name') && children(parent)[0] === c;
}

/** Children of a container element form a group. */
function buildChildren(factory: PatternFactory, el: Element, scope: Scope): Pattern {
  const kids = children(el).filter(
    (c) => !isNameClassChild(c) && c.localName !== 'param' && c.localName !== 'except',
  );
  if (!kids.length) return factory.empty;
  let p = buildPattern(factory, kids[0]!, scope);
  for (let i = 1; i < kids.length; i++) p = factory.group(p, buildPattern(factory, kids[i]!, scope));
  return p;
}

function buildPattern(factory: PatternFactory, el: Element, parentScope: Scope): Pattern {
  const scope = scopeFor(el, parentScope);
  switch (el.localName) {
    case 'empty':
      return factory.empty;
    case 'notAllowed':
      return factory.notAllowed;
    case 'text':
      return factory.text;
    case 'group':
      return buildChildren(factory, el, scope);
    case 'interleave': {
      const kids = children(el);
      let p = buildPattern(factory, kids[0]!, scope);
      for (let i = 1; i < kids.length; i++) p = factory.interleave(p, buildPattern(factory, kids[i]!, scope));
      return p;
    }
    case 'choice': {
      const kids = children(el);
      let p = buildPattern(factory, kids[0]!, scope);
      for (let i = 1; i < kids.length; i++) p = factory.choice(p, buildPattern(factory, kids[i]!, scope));
      return p;
    }
    case 'optional':
      return factory.choice(buildChildren(factory, el, scope), factory.empty);
    case 'zeroOrMore':
      return factory.choice(factory.oneOrMore(buildChildren(factory, el, scope)), factory.empty);
    case 'oneOrMore':
      return factory.oneOrMore(buildChildren(factory, el, scope));
    case 'mixed':
      return factory.interleave(buildChildren(factory, el, scope), factory.text);
    case 'list':
      return factory.list(buildChildren(factory, el, scope));
    case 'ref':
    case 'parentRef': {
      const name = el.getAttribute('name') ?? '';
      const d = scope.defines.get(name);
      if (!d) throw new Error(`Undefined RELAX NG reference "${name}"`);
      // Definitions consisting of a single <element> become lazily resolved element patterns,
      // which makes recursive grammars terminate.
      const kids = children(d.el).filter((c) => c.localName !== 'param');
      if (kids.length === 1 && kids[0]!.localName === 'element' && !d.extra.length) {
        const elEl = kids[0]!;
        const elScope = scopeFor(elEl, scopeFor(d.el, scope));
        const nc = nameClassOf(elEl, elScope, true);
        let ref = d.refs[0];
        if (!ref) {
          ref = { name, p: undefined };
          d.refs.push(ref);
        }
        return factory.element(nc, ref);
      }
      return definePattern(factory, d, scope);
    }
    case 'element': {
      const nc = nameClassOf(el, scope, true);
      const ref: ElementRef = { name: `#${nc.kind === 'name' ? nc.local : '*'}`, p: undefined };
      ref.p = buildChildren(factory, el, scope);
      return factory.element(nc, ref);
    }
    case 'attribute': {
      const nc = nameClassOf(el, scope, false);
      const content = children(el).filter((c) => !isNameClassChild(c));
      const p = content.length ? buildChildren(factory, el, scope) : factory.text;
      return factory.attribute(nc, p);
    }
    case 'value': {
      const dt: Datatype = {
        library: el.hasAttribute('datatypeLibrary')
          ? el.getAttribute('datatypeLibrary')!
          : el.hasAttribute('type')
            ? scope.datatypeLibrary
            : '',
        type: el.getAttribute('type') ?? 'token',
        params: {},
      };
      return factory.value(dt, el.textContent ?? '');
    }
    case 'data': {
      const params: Record<string, string> = {};
      for (const p of children(el, 'param')) params[p.getAttribute('name') ?? ''] = p.textContent ?? '';
      const dt: Datatype = {
        library: scope.datatypeLibrary,
        type: el.getAttribute('type') ?? 'string',
        params,
      };
      const exceptEl = children(el, 'except')[0];
      const except = exceptEl ? buildChildren(factory, exceptEl, scope) : undefined;
      return factory.data(dt, except);
    }
    case 'externalRef':
      throw new Error('externalRef is not supported');
    default:
      throw new Error(`Unsupported RELAX NG element <${el.localName}>`);
  }
}

function nameClassOf(el: Element, scope: Scope, isElement: boolean): NameClass {
  const nameAttr = el.getAttribute('name');
  if (nameAttr !== null) return qnameToNameClass(nameAttr, el, isElement ? scope.ns : '');
  const first = children(el)[0];
  if (!first) throw new Error(`<${el.localName}> without a name`);
  return buildNameClass(first, el, isElement ? scope.ns : '');
}

function qnameToNameClass(qname: string, ctx: Element, defaultNs: string): NameClass {
  const idx = qname.indexOf(':');
  if (idx > 0) {
    const prefix = qname.slice(0, idx);
    const ns = ctx.lookupNamespaceURI(prefix) ?? '';
    return { kind: 'name', ns, local: qname.slice(idx + 1) };
  }
  return { kind: 'name', ns: defaultNs, local: qname };
}

function buildNameClass(el: Element, ctx: Element, defaultNs: string): NameClass {
  const ns = el.hasAttribute('ns') ? el.getAttribute('ns')! : defaultNs;
  switch (el.localName) {
    case 'name':
      return qnameToNameClass((el.textContent ?? '').trim(), el, ns);
    case 'anyName': {
      const ex = children(el, 'except')[0];
      return { kind: 'anyName', except: ex ? buildNameClass(children(ex)[0]!, ctx, ns) : undefined };
    }
    case 'nsName': {
      const ex = children(el, 'except')[0];
      return { kind: 'nsName', ns, except: ex ? buildNameClass(children(ex)[0]!, ctx, ns) : undefined };
    }
    case 'choice': {
      const kids = children(el);
      let nc = buildNameClass(kids[0]!, ctx, ns);
      for (let i = 1; i < kids.length; i++)
        nc = { kind: 'nameChoice', a: nc, b: buildNameClass(kids[i]!, ctx, ns) };
      return nc;
    }
    default:
      throw new Error(`Unsupported name class <${el.localName}>`);
  }
}
