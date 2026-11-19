import { PLAYER_STYLE } from './player.js';

export type FrameTheme = 'dark' | 'light';

/**
 * The page's own colours follow `color-scheme`, which is the panel's theme when it names one.
 * A frame whose scheme differs from the element that holds it gets an opaque canvas behind it,
 * so a mismatch is a white flash in a dark panel; a ground painted here follows the scheme too.
 *
 * `theme` is undefined for a public link, which follows the reader's system.
 */
export const frameStyle = (theme: FrameTheme | undefined) => `
:root { color-scheme: ${theme ?? 'light dark'}; }
html, body { margin: 0; }
body { padding: 16px; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  overflow-wrap: anywhere; }
body.react, body.deck, body.sheet, body.markdown { padding: 0; }
${canvasStyle()}
#failure { margin: 12px; padding: 12px; border-radius: 8px; white-space: pre-wrap;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #b42318;
  background: color-mix(in srgb, #b42318 12%, transparent); }
#failure:empty { display: none; }
img, svg { max-width: 100%; height: auto; }
pre { overflow-x: auto; padding: 12px; border-radius: 8px;
  background: color-mix(in srgb, CanvasText 8%, transparent); }
code { font: .875em ui-monospace, SFMono-Regular, Menlo, monospace; }
table { border-collapse: collapse; }
th, td { padding: 4px 10px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
blockquote { margin-inline: 0; padding-inline-start: 12px;
  border-inline-start: 3px solid color-mix(in srgb, CanvasText 25%, transparent); }
${documentStyle()}
${PLAYER_STYLE}`;

/**
 * A component stands centred on a canvas of dots, the canvas's ground being its own so a component
 * drawn light on a dark panel still has a light canvas. `safe` keeps one larger than the view
 * reachable by scrolling, from its start. `filled` is a component that paints its own ground over
 * the view (document.ts decides): no canvas, and it fills the view from the corner, as one sized
 * to its parent (height 100%, 100vh) expects.
 */
function canvasStyle() {
  return `
body.react { background-color: light-dark(#f4f4f5, #0d0d0f);
  background-image: radial-gradient(light-dark(#00000024, #ffffff1c) 1px, transparent 1.4px);
  background-size: 18px 18px; background-position: 9px 9px; }
body.react #root { box-sizing: border-box; min-height: 100vh; padding: 56px 32px; display: flex;
  flex-direction: column; align-items: safe center; justify-content: safe center; }
body.react.filled { background: none; }
body.react.filled #root { display: block; padding: 0; }`;
}

/**
 * A Markdown document as a page to read: one centred column of about 44rem with room around it,
 * and a rhythm that gives headings more space above than below. It is also what is printed to
 * PDF, so print is always the light scheme with no column limit, and nothing that should stay
 * whole is split across a page. A callout is the one block of HTML the editor writes
 * (`<div class="callout">`, kept as it is in the Markdown), and is drawn here so it reads as one.
 */
function documentStyle() {
  const edge = 'color-mix(in srgb, CanvasText 14%, transparent)';
  const soft = 'color-mix(in srgb, CanvasText 6%, transparent)';

  return `
body.markdown { font-size: 16px; line-height: 1.7; }
body.markdown #root { box-sizing: border-box; max-width: 44rem; margin: 0 auto;
  padding: 56px 28px 120px; min-height: 100vh; }
body.markdown #root > :first-child { margin-top: 0; }
body.markdown :is(h1, h2, h3, h4, h5, h6) { line-height: 1.25; font-weight: 650;
  letter-spacing: -.012em; margin: 2em 0 .6em; }
body.markdown h1 { font-size: 2.1em; margin: 0 0 .7em; letter-spacing: -.02em; }
body.markdown h2 { font-size: 1.5em; padding-bottom: .3em; border-bottom: 1px solid ${edge}; }
body.markdown h3 { font-size: 1.2em; }
body.markdown :is(h4, h5, h6) { font-size: 1em; }
body.markdown :is(p, ul, ol, pre, table, blockquote, details) { margin: 0 0 1.1em; }
body.markdown :is(ul, ol) { padding-inline-start: 1.5em; }
body.markdown li { margin: .3em 0; }
body.markdown li > :is(ul, ol) { margin: .3em 0 0; }
body.markdown li:has(> input[type=checkbox]) { list-style: none; margin-inline-start: -1.5em; }
body.markdown li > input[type=checkbox] { margin: 0 .55em 0 0; vertical-align: -.1em; }
body.markdown a { color: light-dark(#1d4ed8, #8ab4ff); text-underline-offset: .18em;
  text-decoration-thickness: 1px; }
body.markdown hr { border: 0; border-top: 1px solid ${edge}; margin: 2.4em 0; }
body.markdown blockquote { padding: .1em 0 .1em 1.1em; border-inline-start-width: 3px;
  color: color-mix(in srgb, CanvasText 72%, transparent); }
body.markdown blockquote > :last-child { margin-bottom: 0; }
body.markdown pre { padding: 14px 16px; line-height: 1.55; font-size: .875em;
  border: 1px solid ${edge}; background: ${soft}; }
body.markdown pre code { font-size: inherit; background: none; padding: 0; }
body.markdown :not(pre) > code { padding: .15em .4em; border-radius: 5px; background: ${soft}; }
body.markdown table { display: block; max-width: 100%; overflow-x: auto; font-size: .95em; }
body.markdown :is(th, td) { padding: 7px 12px; border-color: ${edge}; }
body.markdown th { text-align: start; font-weight: 600; background: ${soft}; }
body.markdown img { border-radius: 8px; }
body.markdown .callout { margin: 0 0 1.1em; padding: 14px 18px; border-radius: 10px;
  border: 1px solid ${edge}; background: ${soft}; }
body.markdown .callout > :last-child { margin-bottom: 0; }
@media print {
  :root { color-scheme: light !important; }
  body.markdown #root { max-width: none; padding: 0; min-height: 0; }
  body.markdown a { color: inherit; }
  body.markdown :is(h1, h2, h3, h4, h5, h6) { break-after: avoid; }
  body.markdown :is(pre, table, blockquote, img, tr) { break-inside: avoid; }
}`;
}
