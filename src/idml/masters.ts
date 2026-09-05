import type { IdmlDocument } from './document.ts';
import { createStory } from './stories.ts';
import { attr, type Element } from './xml.ts';

/** Gives every text frame inside `container` its own copy of its story (after cloning a master/spread). */
export function duplicateStoriesOf(doc: IdmlDocument, container: Element): void {
  const frames = Array.from(container.getElementsByTagName('TextFrame')) as Element[];
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
