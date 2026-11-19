/**
 * New slides the owner adds by hand, made from a layout in the deck's own look: the styles,
 * the fonts and the ground of a slide the agent drew are kept, and only what it said is swapped
 * for the layout's words. So a new slide matches the deck it joins, not a template of ours.
 *
 * What is kept of the slide it is made from:
 * - its whole head, styles and fonts written in it, but no script: a script drew that slide's
 *   content, which is gone, and on the new one it could only fail or draw the old again;
 * - the body's own attributes (its class and style);
 * - when the body holds one element alone, that element as the slide's frame (often a
 *   `.slide` that sets the size, the padding and the ground), emptied.
 *
 * The layout's words are real text, written to be typed over: the editor selects a text marked
 * `data-jian-placeholder` whole when it is clicked (slide-builder.ts in the gateway). The layout
 * places them with styles of its own and sets no colour or font, which come from the deck.
 */

export type SlideLayout = 'title' | 'text' | 'columns' | 'section' | 'blank';

export const LAYOUTS: readonly { layout: SlideLayout; label: string }[] = [
  { layout: 'title', label: 'Title' },
  { layout: 'text', label: 'Title and text' },
  { layout: 'columns', label: 'Two columns' },
  { layout: 'section', label: 'Section header' },
  { layout: 'blank', label: 'Blank' },
];

const placeholder = (tag: string, text: string, style = '') =>
  `<${tag} data-jian-placeholder=""${style ? ` style="${style}"` : ''}>${text}</${tag}>`;

/** A column of text, as tall as the frame it is in when that has a height, never taller. */
const COLUMN =
  'box-sizing: border-box; display: flex; flex-direction: column; width: 100%; height: 100%; gap: 28px;';

const MARKUP: Record<SlideLayout, string> = {
  title: `<div style="${COLUMN} justify-content: center; align-items: center; text-align: center; padding: 48px 72px;">${placeholder('h1', 'Click to add title', 'margin: 0;')}${placeholder('p', 'Click to add subtitle', 'margin: 0; opacity: .75;')}</div>`,
  text: `<div style="${COLUMN} padding: 48px 72px;">${placeholder('h2', 'Click to add title', 'margin: 0;')}<ul style="margin: 0;">${placeholder('li', 'Click to add text')}</ul></div>`,
  columns: `<div style="${COLUMN} padding: 48px 72px;">${placeholder('h2', 'Click to add title', 'margin: 0;')}<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 56px;">${placeholder('p', 'Click to add text', 'margin: 0;')}${placeholder('p', 'Click to add text', 'margin: 0;')}</div></div>`,
  section: `<div style="${COLUMN} justify-content: center; padding: 48px 72px;">${placeholder('h1', 'Click to add section title', 'margin: 0;')}${placeholder('p', 'Click to add a line about it', 'margin: 0; opacity: .75;')}</div>`,
  blank: '',
};

/** A plain page for a deck whose slide cannot be read: white, in the system's fonts. */
const PLAIN =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>html, body { margin: 0; width: 1280px; height: 720px; } body { background: #fff; color: #111; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 28px; } h1 { font-size: 64px; } h2 { font-size: 44px; }</style></head><body></body></html>';

/** A new slide in the look of `from`, a slide of the same deck, holding `layout`'s words. */
export function layoutSlide(layout: SlideLayout, from: string | undefined): string {
  const page = new DOMParser().parseFromString(from?.trim() ? from : PLAIN, 'text/html');
  for (const script of page.querySelectorAll('script')) script.remove();
  // A page that sends its reader elsewhere does it on the copy too.
  for (const meta of page.querySelectorAll('meta[http-equiv="refresh" i]')) meta.remove();

  const body = page.body;
  const only = body.children.length === 1 ? body.firstElementChild : null;
  // A frame keeps its own ground and size; text of its own beside it would be content.
  const frame =
    only && !/^(H[1-6]|P|UL|OL|IMG|SVG|TABLE|PRE)$/i.test(only.tagName) && !ownText(body)
      ? only
      : body;
  frame.replaceChildren();
  if (frame !== body) body.replaceChildren(frame);
  frame.insertAdjacentHTML('afterbegin', MARKUP[layout]);

  return `${page.doctype ? '<!doctype html>\n' : ''}${page.documentElement.outerHTML}`;
}

/** Whether an element holds words of its own, outside its children. */
const ownText = (element: Element) =>
  [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim());
