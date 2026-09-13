/**
 * Pulls the user-visible strings out of a rendered page - the things anchor search
 * (TDD s5.3) would have to find in the repo.
 */
import type { Page } from 'playwright';

export interface VisibleString {
  text: string;
  /** Tag of the element that directly contains the text node. */
  tag: string;
  /** True when the string sits in site chrome (nav, header, footer) rather than content. */
  chrome: boolean;
}

/** Below this, a string is too generic to anchor anything ("OK", "x", "3"). */
const MIN_LENGTH = 4;

export async function visibleStrings(page: Page): Promise<VisibleString[]> {
  const found = (await page.evaluate(() => {
    const NON_RENDERING = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE']);
    const CHROME = new Set(['NAV', 'HEADER', 'FOOTER']);
    const out: Array<{ text: string; tag: string; chrome: boolean }> = [];
    const seen = new Set<string>();

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const current = node;
      node = walker.nextNode();
      const raw = current.nodeValue ?? '';
      if (!raw.trim()) continue;
      const parent = current.parentElement;
      if (!parent) continue;
      if (NON_RENDERING.has(parent.tagName)) continue;

      // Walk up once to decide visibility and context. aria-hidden subtrees are
      // excluded because they are not exposed to assistive technology, so they are
      // never the node an accessibility finding points at - including them would
      // measure text the product would never need to locate.
      let hidden = false;
      let chrome = false;
      for (let el: Element | null = parent; el && el !== document.body; el = el.parentElement) {
        if (el.getAttribute('aria-hidden') === 'true') { hidden = true; break; }
        if (CHROME.has(el.tagName)) chrome = true;
      }
      if (hidden) continue;
      // A text node with no layout box is not on screen, whatever the CSS says.
      if (parent.getClientRects().length === 0) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || style.opacity === '0') continue;

      const text = raw.replace(/\s+/g, ' ').trim();
      if (seen.has(text)) continue;
      seen.add(text);
      out.push({ text, tag: parent.tagName.toLowerCase(), chrome });
    }
    return out;
  })) as VisibleString[];

  return found.filter((s) => s.text.length >= MIN_LENGTH && /[a-zA-Z]{2}/.test(s.text));
}

/**
 * Caps the sample without biasing it. Taking the longest strings would inflate every
 * rate in this spike, because long strings are both likelier to be authored literally
 * and likelier to be unique - so sample evenly across document order instead and let
 * the length buckets in the report show the effect of length honestly.
 */
export function sample<T>(items: T[], cap: number): T[] {
  if (items.length <= cap) return items;
  const step = items.length / cap;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(items[Math.floor(i * step)]);
  return out;
}
