// RELAX NG patterns with hash-consing so structurally equal patterns share one object.
// Based on James Clark's derivative algorithm (https://relaxng.org/jclark/derivative.html).

export type NameClass =
  | { kind: 'name'; ns: string; local: string }
  | { kind: 'anyName'; except?: NameClass }
  | { kind: 'nsName'; ns: string; except?: NameClass }
  | { kind: 'nameChoice'; a: NameClass; b: NameClass };

export interface Datatype {
  library: string;
  type: string;
  params: Record<string, string>;
}

export type Pattern =
  | { id: number; kind: 'empty' }
  | { id: number; kind: 'notAllowed' }
  | { id: number; kind: 'text' }
  | { id: number; kind: 'choice'; a: Pattern; b: Pattern }
  | { id: number; kind: 'group'; a: Pattern; b: Pattern }
  | { id: number; kind: 'interleave'; a: Pattern; b: Pattern }
  | { id: number; kind: 'oneOrMore'; p: Pattern }
  | { id: number; kind: 'list'; p: Pattern }
  | { id: number; kind: 'data'; dt: Datatype; except?: Pattern }
  | { id: number; kind: 'value'; dt: Datatype; value: string }
  | { id: number; kind: 'attribute'; nc: NameClass; p: Pattern }
  | { id: number; kind: 'element'; nc: NameClass; ref: ElementRef }
  | { id: number; kind: 'after'; a: Pattern; b: Pattern };

/** Element content is resolved lazily so recursive grammars can be built. */
export interface ElementRef {
  /** Unique identity of this element definition (named define or inline element). */
  name: string;
  p: Pattern | undefined;
}

export class PatternFactory {
  private nextId = 1;
  private table = new Map<string, Pattern>();
  readonly empty: Pattern;
  readonly notAllowed: Pattern;
  readonly text: Pattern;

  constructor() {
    this.empty = this.intern('empty', { kind: 'empty' });
    this.notAllowed = this.intern('notAllowed', { kind: 'notAllowed' });
    this.text = this.intern('text', { kind: 'text' });
  }

  private intern<T extends Omit<Pattern, 'id'>>(key: string, p: T): Pattern {
    const existing = this.table.get(key);
    if (existing) return existing;
    const created = { id: this.nextId++, ...p } as unknown as Pattern;
    this.table.set(key, created);
    return created;
  }

  get size(): number {
    return this.table.size;
  }

  choice(a: Pattern, b: Pattern): Pattern {
    if (a.kind === 'notAllowed') return b;
    if (b.kind === 'notAllowed') return a;
    if (a === b) return a;
    // flatten and dedupe nested choices to keep patterns small
    if (containsChoice(b, a)) return b;
    if (containsChoice(a, b)) return a;
    return this.intern(`c${a.id},${b.id}`, { kind: 'choice', a, b });
  }

  group(a: Pattern, b: Pattern): Pattern {
    if (a.kind === 'notAllowed' || b.kind === 'notAllowed') return this.notAllowed;
    if (a.kind === 'empty') return b;
    if (b.kind === 'empty') return a;
    return this.intern(`g${a.id},${b.id}`, { kind: 'group', a, b });
  }

  interleave(a: Pattern, b: Pattern): Pattern {
    if (a.kind === 'notAllowed' || b.kind === 'notAllowed') return this.notAllowed;
    if (a.kind === 'empty') return b;
    if (b.kind === 'empty') return a;
    return this.intern(`i${a.id},${b.id}`, { kind: 'interleave', a, b });
  }

  after(a: Pattern, b: Pattern): Pattern {
    if (a.kind === 'notAllowed' || b.kind === 'notAllowed') return this.notAllowed;
    return this.intern(`a${a.id},${b.id}`, { kind: 'after', a, b });
  }

  oneOrMore(p: Pattern): Pattern {
    if (p.kind === 'notAllowed') return this.notAllowed;
    if (p.kind === 'empty') return this.empty;
    return this.intern(`o${p.id}`, { kind: 'oneOrMore', p });
  }

  list(p: Pattern): Pattern {
    return this.intern(`l${p.id}`, { kind: 'list', p });
  }

  data(dt: Datatype, except?: Pattern): Pattern {
    return this.intern(`d${dt.library}|${dt.type}|${JSON.stringify(dt.params)}|${except?.id ?? ''}`, {
      kind: 'data',
      dt,
      except,
    });
  }

  value(dt: Datatype, value: string): Pattern {
    return this.intern(`v${dt.library}|${dt.type}|${value}`, { kind: 'value', dt, value });
  }

  attribute(nc: NameClass, p: Pattern): Pattern {
    return this.intern(`@${nameClassKey(nc)}|${p.id}`, { kind: 'attribute', nc, p });
  }

  private inlineCounter = 0;

  element(nc: NameClass, ref: ElementRef): Pattern {
    // Inline elements (name starting with "#") are distinct definitions even when they share a name.
    if (ref.name.startsWith('#') && !ref.name.includes('@')) ref.name = `${ref.name}@${this.inlineCounter++}`;
    return this.intern(`e${nameClassKey(nc)}|${ref.name}`, { kind: 'element', nc, ref });
  }

  nameChoice(a: NameClass, b: NameClass): NameClass {
    return { kind: 'nameChoice', a, b };
  }
}

function containsChoice(p: Pattern, needle: Pattern): boolean {
  if (p === needle) return true;
  if (p.kind === 'choice') return containsChoice(p.a, needle) || containsChoice(p.b, needle);
  return false;
}

export function nameClassKey(nc: NameClass): string {
  switch (nc.kind) {
    case 'name':
      return `{${nc.ns}}${nc.local}`;
    case 'anyName':
      return `*${nc.except ? `-${nameClassKey(nc.except)}` : ''}`;
    case 'nsName':
      return `{${nc.ns}}*${nc.except ? `-${nameClassKey(nc.except)}` : ''}`;
    case 'nameChoice':
      return `(${nameClassKey(nc.a)}|${nameClassKey(nc.b)})`;
  }
}

export function nameClassContains(nc: NameClass, ns: string, local: string): boolean {
  switch (nc.kind) {
    case 'name':
      return nc.ns === ns && nc.local === local;
    case 'anyName':
      return !(nc.except && nameClassContains(nc.except, ns, local));
    case 'nsName':
      return nc.ns === ns && !(nc.except && nameClassContains(nc.except, ns, local));
    case 'nameChoice':
      return nameClassContains(nc.a, ns, local) || nameClassContains(nc.b, ns, local);
  }
}

export function nameClassToString(nc: NameClass): string {
  switch (nc.kind) {
    case 'name':
      return nc.local;
    case 'anyName':
      return '*';
    case 'nsName':
      return `{${nc.ns}}:*`;
    case 'nameChoice':
      return `${nameClassToString(nc.a)}|${nameClassToString(nc.b)}`;
  }
}
