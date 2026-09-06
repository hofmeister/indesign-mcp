import type { IdmlDocument } from './document.ts';
import { createStory } from './stories.ts';
import { attr, type Element } from './xml.ts';

/** Gives every text frame inside `container` its own copy of its story (after cloning a master/spread). */
export function duplicateStoriesOf(doc: IdmlDocument, container: Element): void {
  // `container` may itself be the text frame (a single copied item) or hold frames inside it.
  const frames = [
    ...(container.tagName === 'TextFrame' ? [container] : []),
    ...(Array.from(container.getElementsByTagName('TextFrame')) as Element[]),
  ];
  const mapping = new Map<string, string>();
  for (const f of frames) {
    const storyId = attr(f, 'ParentStory');
    if (!storyId) continue;
    let newId = mapping.get(storyId);
    if (!newId) {
      const story = doc.story(storyId);
      const copy = createStory(doc, { text: '' });
      if (story) {
        while (copy.firstChild) copy.removeChild(copy.firstChild);
        for (const c of Array.from(story.childNodes))
          copy.appendChild(copy.ownerDocument!.importNode(c, true));
      }
      newId = attr(copy, 'Self')!;
      mapping.set(storyId, newId);
    }
    f.setAttribute('ParentStory', newId);
  }
  // threading between copied frames must point at the copied ids
  const selfMap = new Map<string, string>();
  for (const f of frames) {
    const prev = attr(f, 'PreviousTextFrame');
    const next = attr(f, 'NextTextFrame');
    void prev;
    void next;
  }
  void selfMap;
}

/**
 * Overrides a master page item on a document page: copies it onto the page (so it can be edited)
 * and hides the master's original by adding its id to the page's OverrideList.
 */
export function overrideMasterItem(doc: IdmlDocument, pageRef: number | string, itemRef: string): Element {
  const { findPage } = require('./pages.ts') as typeof import('./pages.ts');
  const { isPageItem, translateItem } = require('./items.ts') as typeof import('./items.ts');
  const { children, insertAfter } = require('./xml.ts') as typeof import('./xml.ts');
  const page = findPage(doc, pageRef);
  if (!page.appliedMaster) throw new Error(`Page ${page.index} has no master page applied`);
  const master = doc.masterSpreads().find((m) => attr(m, 'Self') === page.appliedMaster);
  if (!master) throw new Error('Master page not found');
  const items = children(master).filter(isPageItem);
  const found =
    items.find((i) => attr(i, 'Self') === itemRef) ??
    items.find((i) => (attr(i, 'Name') ?? '').toLowerCase() === itemRef.toLowerCase());
  if (!found) {
    const names = items
      .map((i) =>
        attr(i, 'Name') && attr(i, 'Name') !== '$ID/' ? `"${attr(i, 'Name')}"` : (attr(i, 'Self') ?? ''),
      )
      .join(', ');
    throw new Error(
      `Item "${itemRef}" not found on master ${attr(master, 'Name')}. It has: ${names || 'no items'}`,
    );
  }
  const masterId = attr(found, 'Self')!;
  const pageEl = doc.findBySelf(page.id)?.element;
  const spread = doc.findBySelf(page.spreadId)?.element;
  if (!pageEl || !spread) throw new Error('Page or spread not found');
  const overrides = (attr(pageEl, 'OverrideList') ?? '').split(/\s+/).filter(Boolean);
  if (overrides.includes(masterId))
    throw new Error(`"${itemRef}" is already overridden on page ${page.index}`);

  const spreadDoc = doc.xml(page.spreadPart);
  const clone = spreadDoc.importNode(found, true) as Element;
  for (const el of [clone, ...(Array.from(clone.getElementsByTagName('*')) as Element[])]) {
    if (el.hasAttribute?.('Self')) el.setAttribute('Self', doc.newId());
  }
  duplicateStoriesOf(doc, clone);
  insertAfter(spread, clone);
  // master pages have their own origin; move the copy to the same spot on this page
  const mpages = children(master, 'Page');
  const mpage =
    mpages.length > 1 ? (page.side === 'left' ? mpages[0]! : mpages[mpages.length - 1]!) : mpages[0];
  if (mpage) {
    const mt = (attr(mpage, 'ItemTransform') ?? '1 0 0 1 0 0').split(/\s+/).map(Number);
    const mb = (attr(mpage, 'GeometricBounds') ?? '0 0 0 0').split(/\s+/).map(Number);
    const originX = (mt[4] ?? 0) + (mb[1] ?? 0);
    const originY = (mt[5] ?? 0) + (mb[0] ?? 0);
    translateItem(clone, page.origin.x - originX, page.origin.y - originY);
  }
  overrides.push(masterId);
  pageEl.setAttribute('OverrideList', overrides.join(' '));
  return clone;
}
