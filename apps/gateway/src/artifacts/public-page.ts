import {
  COMPONENT_PROMPT_TARGETS,
  componentPromptParts,
  PUBLIC_ARTIFACT_FORMAT_LABEL,
  PUBLIC_ARTIFACT_FORMATS,
  type SessionArtifactType,
} from '@jian/contracts';

/**
 * The page a public link answers, around the Artifact: the gateway's own, never the agent's. It
 * holds the Artifact's page in a sandboxed `srcdoc` frame that fills the window, and over it a
 * toolbar that takes none of the window's room: it slides in while the pointer is at the top
 * edge or the keyboard is in it, and on a touch screen from a small handle at the top.
 *
 * What the toolbar needs this page to be allowed, and why the Artifact still cannot:
 *
 * - `allow-downloads`, which the page is served with (routes.ts) beside `allow-scripts`, lets
 *   its Download menu save a file. A frame's sandbox flags are the ones its own `sandbox`
 *   attribute grants, intersected with its parent's: the Artifact's frame is given
 *   `allow-scripts` alone, so it saves nothing, and neither does any frame inside it.
 * - Copying needs no flag: the clipboard is written from this page, on the reader's click, and
 *   only with what the page already holds (the prompts). The Artifact cannot reach it, and this
 *   page reads nothing the Artifact says: no message is listened for.
 * - Nothing else is loosened. `frame-src 'none'` still refuses every navigation of the frame,
 *   which is removed should one get through, as in every shell (document.ts).
 */

/** Inside a script element nothing may read as markup, and `<` is all that could. */
const data = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');

/** Text as it stands inside markup or a quoted attribute, a frame's `srcdoc` included. */
const text = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Jian's mark, as the brand's own one-colour logo draws it, in the toolbar's ink. */
const LOGO = `<svg viewBox="0 0 96 96" aria-hidden="true" fill="currentColor"><path d="M8 68C28 64 45 51 60 27c2 14-2 27-11 37 13-5 26-16 37-33-2 25-15 42-38 50-16 5-30 1-40-13Z"/><path d="M54 71c11-2 21-8 29-17l10-1-9 7c-7 14-21 24-41 25-8 0-16-2-22-5 13 1 24-2 33-9Z"/></svg>`;

const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** Lucide's, as the panel draws the same actions. */
const ICONS = {
  download: icon(
    '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  ),
  copy: icon(
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  ),
  check: icon('<path d="M20 6 9 17l-5-5"/>'),
  chevron: icon('<path d="m6 9 6 6 6-6"/>'),
  hide: icon('<path d="m18 15-6-6-6 6"/>'),
};

/**
 * The kit's glass (packages/ui/src/styles), written out: this page loads nothing, so none of the
 * panel's styles reach it. Light first, dark where the reader's system is; the font is the
 * system's, since a font could only come from the network.
 */
const STYLE = `
:root { color-scheme: light dark; --ink: #171716; --muted: #686864;
  --glass: color-mix(in srgb, #ffffff 82%, transparent);
  --glass-edge: color-mix(in srgb, #000000 8%, transparent);
  --glass-light: color-mix(in srgb, #ffffff 70%, transparent);
  --glass-shadow: 0 18px 48px -16px rgb(0 0 0 / .18), 0 2px 8px -2px rgb(0 0 0 / .08);
  --glass-hover: color-mix(in srgb, #000000 5%, transparent);
  --glass-press: color-mix(in srgb, #000000 9%, transparent);
  --good: #237a51; --bad: #b22e3d; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #f5f5f3; --muted: #a6a6a3;
    --glass: color-mix(in srgb, #141414 78%, transparent);
    --glass-edge: color-mix(in srgb, #ffffff 9%, transparent);
    --glass-light: color-mix(in srgb, #ffffff 7%, transparent);
    --glass-shadow: 0 18px 48px -16px rgb(0 0 0 / .65), 0 2px 8px -2px rgb(0 0 0 / .4);
    --glass-hover: color-mix(in srgb, #ffffff 7%, transparent);
    --glass-press: color-mix(in srgb, #ffffff 11%, transparent);
    --good: #84d6ae; --bad: #fb8791; }
}
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
#artifact { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
#top { position: fixed; inset: 0 0 auto; z-index: 1; pointer-events: none;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); }
/* The strip the pointer finds the toolbar by. Thin, since it covers the top of the Artifact. */
#edge { height: 10px; pointer-events: auto; }
.glass { background: var(--glass); border: 1px solid var(--glass-edge);
  box-shadow: inset 0 1px 0 var(--glass-light), var(--glass-shadow);
  -webkit-backdrop-filter: blur(40px) saturate(170%); backdrop-filter: blur(40px) saturate(170%); }
#bar { position: absolute; top: 8px; left: 8px; right: 8px; max-width: 960px; margin: 0 auto;
  box-sizing: border-box; display: flex; align-items: center; gap: 4px; height: 46px;
  padding: 0 6px 0 12px; border-radius: 14px; opacity: 0; pointer-events: none;
  transform: translateY(calc(-100% - 12px));
  transition: transform 180ms ease 300ms, opacity 180ms ease 300ms; }
#top:hover #bar, #top:focus-within #bar, #top.open #bar, #top.held #bar {
  opacity: 1; transform: none; pointer-events: auto; transition-delay: 0s; }
#brand { display: grid; place-items: center; flex: none; width: 22px; height: 22px; }
#brand svg { width: 20px; height: 20px; }
#name { flex: 1; min-width: 0; margin: 0 8px 0 6px; font-size: 13px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tool, [role=menuitem] { display: flex; align-items: center; gap: 6px; height: 32px;
  padding: 0 10px; border: 0; border-radius: 8px; font: inherit; color: inherit;
  background: none; cursor: pointer; white-space: nowrap; text-decoration: none; }
.tool:hover, .tool[aria-expanded=true] { background: var(--glass-hover); }
.tool svg, [role=menuitem] svg { flex: none; width: 15px; height: 15px; }
.tool .chevron { width: 13px; height: 13px; color: var(--muted); }
.tool.done { color: var(--good); }
.tool.failed { color: var(--bad); }
:is(.tool, [role=menuitem], #handle):focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 45%, transparent); outline-offset: -2px; }
.menu { position: relative; }
[role=menu] { position: absolute; top: calc(100% + 8px); right: 0; min-width: 200px;
  padding: 4px; border-radius: 12px; display: flex; flex-direction: column; }
[role=menu][hidden] { display: none; }
[role=menuitem] { width: 100%; box-sizing: border-box; text-align: start; }
[role=menuitem]:is(:hover, :focus) { background: var(--glass-press); outline: none; }
.caption { padding: 6px 10px 4px; color: var(--muted); font-size: 12px; }
#handle, #hide { display: none; }
#handle { position: absolute; top: 0; left: 50%; width: 64px; height: 24px; margin-left: -32px;
  padding: 0; border: 0; background: none; pointer-events: auto; cursor: pointer; }
#handle span { display: block; width: 36px; height: 5px; margin: 7px auto 0; border-radius: 99px;
  background: color-mix(in srgb, CanvasText 32%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, Canvas 55%, transparent); }
.quiet { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
/* A touch screen has no pointer resting at the top: a tap on the handle shows the toolbar, and
   a button in it hides it again. */
@media (hover: none) {
  #edge { display: none; }
  #handle { display: block; }
  #hide { display: flex; }
}
@media (max-width: 560px) { .tool .label { display: none; } }
@media (prefers-reduced-motion: reduce) {
  #bar { transform: none; transition: opacity 120ms ease 300ms; }
}`;

/**
 * The page's script: the frame kept from going anywhere, the menus, and copying. It reads only
 * what this page holds; the Artifact's frame is never listened to.
 */
const SCRIPT = `(() => {
  const frame = document.getElementById('artifact');
  let loaded = false;
  // A frame loads once: a second load is a navigation, and the frame goes rather than follow it.
  frame.addEventListener('load', () => {
    if (loaded) return frame.remove();
    loaded = true;
  });
  const top = document.getElementById('top');
  const said = document.getElementById('said');
  const menus = [...document.querySelectorAll('.menu')];
  const items = (menu) => [...menu.querySelectorAll('[role=menuitem]')];
  const toggle = (menu, open) => {
    menu.querySelector('.tool').setAttribute('aria-expanded', String(open));
    menu.querySelector('[role=menu]').hidden = !open;
    // An open menu keeps the toolbar out, wherever the pointer goes.
    top.classList.toggle('held', menus.some((each) => !each.querySelector('[role=menu]').hidden));
  };
  const close = () => { for (const menu of menus) toggle(menu, false); };
  for (const menu of menus) {
    const button = menu.querySelector('.tool');
    const open = () => { close(); toggle(menu, true); items(menu)[0].focus(); };
    button.addEventListener('click', () => button.getAttribute('aria-expanded') === 'true' ? toggle(menu, false) : open());
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      open();
    });
    menu.addEventListener('keydown', (event) => {
      const list = items(menu);
      const at = list.indexOf(document.activeElement);
      if (at < 0) return;
      const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[event.key];
      if (to !== undefined) {
        event.preventDefault();
        list[(to + list.length) % list.length].focus();
      } else if (event.key === 'Escape') {
        toggle(menu, false);
        button.focus();
      } else if (event.key === 'Tab') {
        toggle(menu, false);
      }
    });
    // A download goes on its way; the menu closes behind it.
    for (const link of menu.querySelectorAll('a')) link.addEventListener('click', () => setTimeout(close));
  }
  document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.menu')) close(); });
  // A click in the Artifact takes the focus into its frame, which this page sees as its own
  // window losing it: whatever the toolbar had open closes.
  addEventListener('blur', () => { close(); top.classList.remove('open'); });
  const handle = document.getElementById('handle');
  const reveal = (open) => {
    top.classList.toggle('open', open);
    handle.setAttribute('aria-expanded', String(open));
  };
  handle.addEventListener('click', () => reveal(!top.classList.contains('open')));
  document.getElementById('hide').addEventListener('click', () => { close(); reveal(false); });

  const prompt = document.getElementById('prompt');
  if (!prompt) return;
  const { source, parts } = JSON.parse(prompt.textContent);
  // The clipboard's own call first. A browser may refuse it to a sandboxed page; a selection
  // copied the old way is the fallback, which every browser allows on a click.
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    document.body.append(area);
    area.select();
    let done = false;
    try {
      done = document.execCommand('copy');
    } catch {}
    area.remove();
    return done;
  };
  const button = document.querySelector('#prompts .tool');
  const idle = button.innerHTML;
  let shown;
  for (const item of document.querySelectorAll('[data-target]')) {
    item.addEventListener('click', async () => {
      const [before, after] = parts[item.dataset.target];
      const done = await copy(before + source + after);
      close();
      button.focus();
      button.innerHTML = done ? ${data(ICONS.check)} + '<span class="label">Copied</span>' : idle;
      if (!done) button.querySelector('.label').textContent = 'Could not copy';
      button.classList.toggle('done', done);
      button.classList.toggle('failed', !done);
      said.textContent = done ? 'Prompt for ' + item.textContent + ' copied.' : 'The prompt could not be copied.';
      // Held out long enough to be read, wherever the pointer went.
      top.classList.add('held');
      clearTimeout(shown);
      shown = setTimeout(() => {
        button.innerHTML = idle;
        button.classList.remove('done', 'failed');
        said.textContent = '';
        top.classList.toggle('held', menus.some((each) => !each.querySelector('[role=menu]').hidden));
      }, 1800);
    });
  }
})();`;

/** A button that opens a menu, and the menu. */
const menu = (id: string, label: string, glyph: string, entries: string, caption?: string) => `
<div class="menu" id="${id}">
<button type="button" class="tool" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}-menu">${glyph}<span class="label">${label}</span>${ICONS.chevron.replace('<svg', '<svg class="chevron"')}</button>
<div role="menu" id="${id}-menu" class="glass" aria-label="${label}" hidden>${caption ? `<div class="caption" aria-hidden="true">${caption}</div>` : ''}${entries}</div>
</div>`;

/**
 * The public page for one Artifact. `inner` is the Artifact's own page, as its frame's `srcdoc`.
 * `token` addresses its downloads, relative to the page itself so a gateway behind a path still
 * finds them; with none it offers none. `written` is a component's source as written, which only
 * a component's page is given, for its prompts.
 */
export function publicPage(
  inner: string,
  {
    type,
    title,
    token,
    written,
    fullscreen = false,
  }: {
    type: SessionArtifactType;
    title: string;
    token?: string | undefined;
    written?: string | undefined;
    fullscreen?: boolean;
  },
): string {
  const downloads = token
    ? menu(
        'downloads',
        'Download',
        ICONS.download,
        PUBLIC_ARTIFACT_FORMATS[type]
          .map(
            (format) =>
              `<a role="menuitem" tabindex="-1" href="${text(`${token}/export?format=${format}`)}" download>${text(PUBLIC_ARTIFACT_FORMAT_LABEL[format])}</a>`,
          )
          .join(''),
      )
    : '';
  const prompts =
    type === 'react' && written !== undefined
      ? menu(
          'prompts',
          'Copy prompt',
          ICONS.copy,
          COMPONENT_PROMPT_TARGETS.map(
            (target) =>
              `<button type="button" role="menuitem" tabindex="-1" data-target="${target.id}">${text(target.label)}</button>`,
          ).join(''),
          'A prompt for an AI, to use it in',
        )
      : '';
  // The source once, and around it what each prompt says: the page puts them together on a
  // click, so a long component is not written into the page once for every framework.
  const promptData = prompts
    ? `
<script type="application/json" id="prompt">${data({
        source: written,
        parts: Object.fromEntries(
          COMPONENT_PROMPT_TARGETS.map((target) => [
            target.id,
            componentPromptParts(target.id, title, written ?? ''),
          ]),
        ),
      })}</script>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${text(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<!-- The toolbar first, so the keyboard reaches it before the Artifact. -->
<div id="top">
<div id="edge"></div>
<button type="button" id="handle" aria-label="Show the toolbar" aria-expanded="false" aria-controls="bar"><span></span></button>
<header id="bar" class="glass" aria-label="Artifact">
<span id="brand" title="Made with Jian">${LOGO}</span>
<h1 id="name">${text(title)}</h1>${prompts}${downloads}
<button type="button" class="tool" id="hide" aria-label="Hide the toolbar">${ICONS.hide}</button>
</header>
</div>
<iframe id="artifact" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${text(title)}"${fullscreen ? ' allowfullscreen' : ''} srcdoc="${text(inner)}"></iframe>
<p id="said" class="quiet" role="status"></p>${promptData}
<script>${SCRIPT}</script>
</body>
</html>
`;
}
