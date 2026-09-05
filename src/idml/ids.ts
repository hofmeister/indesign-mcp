// InDesign object ids look like "u1a3": a "u" followed by a base-36 number. New ids must not
// collide with any Self attribute already in the package.
export class IdGenerator {
  private used = new Set<string>();
  private counter: number;

  constructor(existing: Iterable<string> = [], start = 0x1000) {
    this.counter = start;
    for (const id of existing) this.add(id);
  }

  add(id: string): void {
    this.used.add(id);
    const m = /^u([0-9a-z]+)$/.exec(id);
    if (m) {
      const n = Number.parseInt(m[1]!, 36);
      if (Number.isFinite(n) && n >= this.counter) this.counter = n + 1;
    }
  }

  has(id: string): boolean {
    return this.used.has(id);
  }

  next(): string {
    let id: string;
    do {
      id = `u${(this.counter++).toString(36)}`;
    } while (this.used.has(id));
    this.used.add(id);
    return id;
  }
}

/** Escapes a user-facing name the way InDesign does inside Self ids (":" becomes "%3a"). */
export function encodeStyleName(name: string): string {
  return name.replace(/%/g, '%25').replace(/:/g, '%3a').replace(/\//g, '%2f');
}

export function decodeStyleName(id: string): string {
  return id.replace(/%3a/gi, ':').replace(/%2f/gi, '/').replace(/%25/g, '%');
}

/** "ParagraphStyle/Heading 1" -> "Heading 1"; "$ID/NormalParagraphStyle" -> "[Basic Paragraph]". */
export function displayStyleName(selfOrName: string): string {
  let n = selfOrName.replace(
    /^(ParagraphStyle|CharacterStyle|ObjectStyle|CellStyle|TableStyle|Color|Swatch|Gradient|StrokeStyle|XMLTag)\//,
    '',
  );
  n = decodeStyleName(n);
  if (n === '$ID/NormalParagraphStyle') return '[Basic Paragraph]';
  if (n.startsWith('$ID/')) n = n.slice(4);
  return n;
}
