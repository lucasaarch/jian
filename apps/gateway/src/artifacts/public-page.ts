import {
  COMPONENT_PROMPT_TARGETS,
  componentPromptParts,
  PUBLIC_ARTIFACT_FORMAT_LABEL,
  PUBLIC_ARTIFACT_FORMATS,
  type SessionArtifactType,
} from '@jian/contracts';

/**
 * The page a public link answers, around the Artifact: the gateway's own, never the agent's. A
 * toolbar stands across its top, always, in a room of its own, so whoever opens the link sees what
 * it is, where it was made and what they can take away; the Artifact's page fills the rest, in a
 * sandboxed `srcdoc` frame.
 *
 * What the toolbar needs this page to be allowed, and why the Artifact still cannot:
 *
 * - `allow-downloads`, which the page is served with (routes.ts) beside `allow-scripts`, lets
 *   its Download menu save a file.
 * - `allow-popups` and `allow-popups-to-escape-sandbox` let its links to Jian open in a tab of
 *   their own, as an ordinary page there rather than one sealed like this.
 * - A frame's sandbox flags are the ones its own `sandbox` attribute grants, intersected with its
 *   parent's: the Artifact's frame is given `allow-scripts` alone, so it saves nothing and opens
 *   nothing, and neither does any frame inside it.
 * - Copying needs no flag: the clipboard is written from this page, on the reader's click, and
 *   only with what the page already holds (the prompts). The Artifact cannot reach it, and this
 *   page reads nothing the Artifact says: no message is listened for.
 * - Nothing else is loosened. `frame-src 'none'` still refuses every navigation of the frame,
 *   which is removed should one get through, as in every shell (document.ts).
 */

/** Where the toolbar sends a reader who wants Jian. */
const JIAN = {
  site: 'https://usejian.app',
  download: 'https://usejian.app/download',
  repository: 'https://github.com/lucasaarch/jian',
};

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
  external: icon('<path d="M7 17 17 7"/><path d="M7 7h10v10"/>'),
  // GitHub's own mark, filled, as the panel's About shows it.
  github: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-1.97c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>`,
};

/**
 * The kit's glass (packages/ui/src/styles), written out: this page loads nothing, so none of the
 * panel's styles reach it. Light first, dark where the reader's system is; the font is the
 * system's, since a font could only come from the network.
 */
const STYLE = `
:root { color-scheme: light dark; --ink: #171716; --muted: #686864; --canvas: #f7f7f5;
  --glass: color-mix(in srgb, #ffffff 82%, transparent);
  --glass-edge: color-mix(in srgb, #000000 8%, transparent);
  --glass-light: color-mix(in srgb, #ffffff 70%, transparent);
  --glass-shadow: 0 18px 48px -16px rgb(0 0 0 / .18), 0 2px 8px -2px rgb(0 0 0 / .08);
  --glass-hover: color-mix(in srgb, #000000 5%, transparent);
  --glass-press: color-mix(in srgb, #000000 9%, transparent);
  --good: #237a51; --bad: #b22e3d; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #f5f5f3; --muted: #a6a6a3; --canvas: #0f0f0f;
    --glass: color-mix(in srgb, #141414 78%, transparent);
    --glass-edge: color-mix(in srgb, #ffffff 9%, transparent);
    --glass-light: color-mix(in srgb, #ffffff 7%, transparent);
    --glass-shadow: 0 18px 48px -16px rgb(0 0 0 / .65), 0 2px 8px -2px rgb(0 0 0 / .4);
    --glass-hover: color-mix(in srgb, #ffffff 7%, transparent);
    --glass-press: color-mix(in srgb, #ffffff 11%, transparent);
    --good: #84d6ae; --bad: #fb8791; }
}
html, body { margin: 0; height: 100%; }
/* The toolbar, then the Artifact filling what is left: the page itself never scrolls, so the
   toolbar stays where it is while the Artifact scrolls in its own frame. */
body { display: flex; flex-direction: column; overflow: hidden; background: var(--canvas);
  color: var(--ink); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
#artifact { flex: 1; min-height: 0; width: 100%; border: 0; display: block; }
.glass { background: var(--glass); border: 1px solid var(--glass-edge);
  box-shadow: inset 0 1px 0 var(--glass-light), var(--glass-shadow);
  -webkit-backdrop-filter: blur(40px) saturate(170%); backdrop-filter: blur(40px) saturate(170%); }
/* Above the Artifact's frame, so its menus open over it. */
#bar { position: relative; z-index: 1; flex: none; box-sizing: border-box; display: flex;
  align-items: center; gap: 4px; height: 48px; padding: 0 10px 0 8px; background: var(--glass);
  border-bottom: 1px solid var(--glass-edge);
  -webkit-backdrop-filter: blur(40px) saturate(170%); backdrop-filter: blur(40px) saturate(170%); }
#brand { flex: none; font-weight: 650; letter-spacing: -.01em; }
#brand svg { width: 18px; height: 18px; }
.divider { flex: none; width: 1px; height: 18px; margin: 0 6px 0 2px; background: var(--glass-edge); }
#name { flex: 1; min-width: 0; margin: 0 8px 0 0; font-size: 13px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tool, [role=menuitem] { display: flex; align-items: center; gap: 6px; height: 32px;
  padding: 0 10px; border: 0; border-radius: 8px; font: inherit; color: inherit;
  background: none; cursor: pointer; white-space: nowrap; text-decoration: none; }
.tool:hover, .tool[aria-expanded=true] { background: var(--glass-hover); }
.tool svg, [role=menuitem] svg { flex: none; width: 15px; height: 15px; }
.tool .chevron { width: 13px; height: 13px; color: var(--muted); }
.tool.done { color: var(--good); }
.tool.failed { color: var(--bad); }
.tool.get { margin-left: 2px; padding: 0 12px; border-radius: 999px; background: var(--ink);
  color: var(--canvas); font-weight: 600; }
.tool.get:hover { background: color-mix(in srgb, var(--ink) 86%, var(--canvas)); }
.tool.get svg { width: 13px; height: 13px; }
:is(.tool, [role=menuitem]):focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 45%, transparent); outline-offset: -2px; }
.menu { position: relative; }
[role=menu] { position: absolute; top: calc(100% + 8px); right: 0; min-width: 200px;
  padding: 4px; border-radius: 12px; display: flex; flex-direction: column; outline: none; }
[role=menu][hidden] { display: none; }
[role=menuitem] { width: 100%; box-sizing: border-box; text-align: start; }
/* One entry lit at a time: the one the pointer is on, or the keyboard's when it moves through
   them. The pointer moving over one gives it the focus (the script), so the two never differ. */
[role=menuitem]:focus { background: var(--glass-press); outline: none; }
.caption { padding: 6px 10px 4px; color: var(--muted); font-size: 12px; }
.quiet { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
@media (max-width: 640px) {
  .tool .label, .divider { display: none; }
  #brand .label { display: none; }
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
  const said = document.getElementById('said');
  const menus = [...document.querySelectorAll('.menu')];
  const items = (menu) => [...menu.querySelectorAll('[role=menuitem]')];
  const toggle = (menu, open) => {
    menu.querySelector('.tool').setAttribute('aria-expanded', String(open));
    menu.querySelector('[role=menu]').hidden = !open;
  };
  const close = () => { for (const menu of menus) toggle(menu, false); };
  for (const menu of menus) {
    const button = menu.querySelector('.tool');
    const list = menu.querySelector('[role=menu]');
    // Opened from the keyboard, the first entry has the focus; opened with the pointer, none does
    // until the pointer is on one, so no entry is lit that the reader did not point at.
    const open = (keyboard) => {
      close();
      toggle(menu, true);
      (keyboard ? items(menu)[0] : list).focus();
    };
    button.addEventListener('click', (event) =>
      button.getAttribute('aria-expanded') === 'true' ? toggle(menu, false) : open(event.detail === 0));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      // The menu below hears keys too: this one opened it, and must not also move through it.
      event.stopPropagation();
      open(true);
    });
    for (const item of items(menu)) item.addEventListener('pointermove', () => item.focus());
    list.addEventListener('pointerleave', () => { if (!list.hidden) list.focus(); });
    menu.addEventListener('keydown', (event) => {
      const entries = items(menu);
      const at = entries.indexOf(document.activeElement);
      const to = { ArrowDown: at + 1, ArrowUp: at < 0 ? -1 : at - 1, Home: 0, End: entries.length - 1 }[event.key];
      if (to !== undefined && !list.hidden) {
        event.preventDefault();
        entries[(to + entries.length) % entries.length].focus();
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
  addEventListener('blur', close);

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
      clearTimeout(shown);
      shown = setTimeout(() => {
        button.innerHTML = idle;
        button.classList.remove('done', 'failed');
        said.textContent = '';
      }, 1800);
    });
  }
})();`;

/** A button that opens a menu, and the menu. */
const menu = (id: string, label: string, glyph: string, entries: string, caption?: string) => `
<div class="menu" id="${id}">
<button type="button" class="tool" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}-menu">${glyph}<span class="label">${label}</span>${ICONS.chevron.replace('<svg', '<svg class="chevron"')}</button>
<div role="menu" id="${id}-menu" class="glass" aria-label="${label}" tabindex="-1" hidden>${caption ? `<div class="caption" aria-hidden="true">${caption}</div>` : ''}${entries}</div>
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
<header id="bar" aria-label="Artifact">
<a class="tool" id="brand" href="${JIAN.site}" target="_blank" rel="noopener noreferrer" title="Made with Jian">${LOGO}<span class="label">Jian</span></a>
<span class="divider" aria-hidden="true"></span>
<h1 id="name">${text(title)}</h1>${prompts}${downloads}
<a class="tool" href="${JIAN.repository}" target="_blank" rel="noopener noreferrer" aria-label="Jian on GitHub">${ICONS.github}<span class="label">GitHub</span></a>
<a class="tool get" href="${JIAN.download}" target="_blank" rel="noopener noreferrer">Get Jian${ICONS.external}</a>
</header>
<iframe id="artifact" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${text(title)}"${fullscreen ? ' allowfullscreen' : ''} srcdoc="${text(inner)}"></iframe>
<p id="said" class="quiet" role="status"></p>${promptData}
<script>${SCRIPT}</script>
</body>
</html>
`;
}
