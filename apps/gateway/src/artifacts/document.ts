import {
  ARTIFACT_EDIT_MESSAGE,
  ARTIFACT_FRAME_MESSAGE,
  EDITABLE_ARTIFACT_TYPES,
  type SessionArtifactType,
} from '@jian/contracts';
import { GatewayError } from '../core/errors.js';
import { EDITING } from './edit-frame.js';
import { PLAYER, PLAYER_STYLE } from './player.js';
import { type RuntimeFile, runtimeSource } from './runtime.js';

/**
 * The page an Artifact is drawn in. It is the only thing that ever runs what an agent wrote, so
 * everything here is about what that page cannot do.
 *
 * - `sandbox allow-scripts` gives the page an origin of its own that matches nothing: no cookie,
 *   no storage, and no reading of the panel or the gateway, even opened in a tab by itself.
 * - Nothing loads from anywhere: scripts and styles are the ones written in the page, pictures
 *   and fonts only `data:` and `blob:`. `connect-src 'none'` is what keeps it from calling the
 *   gateway, or anyone.
 * - No form is sent and no frame is loaded inside it. A public deck holds each slide in a frame
 *   written into the page itself, which is bound by this same policy and sandbox.
 * - The Artifact's own page cannot take itself anywhere. `navigate-to` does not exist in browsers,
 *   so no policy stops `location = …` or `<meta http-equiv=refresh>` on the page that holds them.
 *   The Artifact therefore runs in a frame of its own inside a shell (`shell` below), and the
 *   shell's `frame-src 'none'` is checked on every navigation of that frame: whatever it tries
 *   to load, a URL included, is refused. A GET to a stranger's address is a way out for data.
 *   The frame the owner edits in sits in a shell too, one that relays both ways: what its parent
 *   says goes in, and only what carries the edit message key comes out.
 * - Only a public deck's frame may take the whole screen, to be presented. That frame runs the
 *   gateway's own player (player.ts); what the agent wrote is each slide, one frame further in,
 *   which is given no such leave.
 *
 * `'unsafe-inline'` is the point, not a hole: the page exists to run the Artifact's own script.
 * `eval` stays refused, which none of the libraries needs.
 *
 * The page takes its source and gives nothing back: it posts no message, and the panel listens
 * for none. The one exception is the frame the owner opens to edit a page by hand
 * (edit-frame.ts), which runs nothing of the Artifact and answers the panel's request for the
 * edited markup; a public link never serves it.
 */
export function artifactPolicy(ancestors: "'self'" | "'none'"): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    `frame-ancestors ${ancestors}`,
    'sandbox allow-scripts',
  ].join('; ');
}

const STYLE = `
:root { color-scheme: light dark; }
html, body { margin: 0; }
body { padding: 16px; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  overflow-wrap: anywhere; }
body.react, body.deck { padding: 0; }
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
${PLAYER_STYLE}`;

// A whole page, written into the one being read. This runs while the page is still parsed, so
// the source carries on from here and the page loads once. Never `document.open` on a page that
// has loaded: it loads again, which the shell takes for a navigation (`shell` below).
const WRITE = `document.write(source);`;

/**
 * How each type is drawn, as the body of `async (source, libraries) => { … }` in the page, with
 * `root` and `run` in reach. `libraries` are the type's files below, in their order.
 *
 * `whole` is a type whose source is a page already. In the panel the shell makes the frame out
 * of it and no page of ours stands between (`shell` below); `body` is then only how its public
 * page, which arrives holding the source, draws it.
 */
const DRAW: Record<
  SessionArtifactType,
  { libraries: readonly RuntimeFile[]; body: string; whole?: true }
> = {
  html: { libraries: [], body: WRITE, whole: true },
  // The panel hands its frame one slide, a page like any other; the public page holds them all.
  deck: { libraries: [], body: PLAYER, whole: true },
  // Markup set this way runs no script element of its own.
  svg: { libraries: [], body: `root.innerHTML = source;` },
  markdown: {
    libraries: ['marked'],
    body: `run(libraries[0]); root.innerHTML = marked.parse(source);`,
  },
  mermaid: {
    libraries: ['mermaid'],
    body: `run(libraries[0]);
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
});
root.innerHTML = (await mermaid.render('diagram', source)).svg;`,
  },
  // React ships as CommonJS, and the component arrives compiled to it: each is wrapped in a
  // function and handed a require that knows these few names and nothing else.
  react: {
    libraries: ['react', 'scheduler', 'react-dom', 'react-dom-client'],
    body: `const modules = {};
const define = (name, code) => {
  let factory;
  window.jianModule = (given) => { factory = given; };
  run('jianModule(function (require, module, exports) {' + code + '\\n});');
  delete window.jianModule;
  if (!factory) throw new Error('The component could not be read.');
  const module = { exports: {} };
  factory((id) => {
    if (id in modules) return modules[id];
    throw new Error('Only react and react-dom can be imported, not "' + id + '".');
  }, module, module.exports);
  modules[name] = module.exports;
  return module.exports;
};
const React = define('react', libraries[0]);
define('scheduler', libraries[1]);
define('react-dom', libraries[2]);
const { createRoot } = define('react-dom/client', libraries[3]);
// A component written without importing React still finds it.
window.React = React;
const Component = define('artifact', source).default;
if (!Component) throw new Error('The component must be the default export.');
createRoot(root).render(React.createElement(Component));`,
  },
};

/** Inside a script element nothing may read as markup, and `<` is all that could. */
const embedded = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');

/** Text as it stands inside markup or a quoted attribute, a frame's `srcdoc` included. */
export const escaped = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The page for one type. With no `artifact` it is the empty frame: it draws the first source its
 * parent posts to it, and only its parent's. With one it draws that, and listens to no one.
 * `editing` is the empty frame the owner edits in: it opens what it is handed for editing
 * (edit-frame.ts) and never draws, so nothing of the Artifact runs in it.
 */
function page(
  type: SessionArtifactType,
  artifact?: { title: string; source: string },
  editing = false,
): string {
  const { libraries, body } = DRAW[type];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escaped(artifact?.title ?? 'Artifact')}</title>
<style>${STYLE}</style>
</head>
<body class="${type}">
<pre id="failure"></pre>
<div id="root"></div>
<script type="application/json" id="libraries">${embedded(libraries.map(runtimeSource))}</script>
<script type="application/json" id="artifact">${embedded(artifact?.source ?? null)}</script>
<script>
(() => {
  const read = (id) => JSON.parse(document.getElementById(id).textContent);
  const root = document.getElementById('root');
  const failure = document.getElementById('failure');
  const fail = (error) => { failure.textContent = String((error && error.message) || error); };
  addEventListener('error', (event) => fail(event.message));
  addEventListener('unhandledrejection', (event) => fail(event.reason));
  // A script element made here runs at once, under the page's policy, with no eval.
  const run = (code) => {
    const script = document.createElement('script');
    script.textContent = code;
    document.head.append(script);
    script.remove();
  };
  const draw = async (source, libraries) => {
${editing ? '' : body}
  };${editing ? EDITING : ''}
  const show = (source) => draw(source, read('libraries')).catch(fail);
  const given = read('artifact');
  if (given !== null) return show(given);
  const hear = (event) => {
    const source = event.source === parent && event.data && event.data.${ARTIFACT_FRAME_MESSAGE};
    if (typeof source !== 'string') return;
    removeEventListener('message', hear);
    ${editing ? `editing(source, event.data.${ARTIFACT_EDIT_MESSAGE});` : 'show(source);'}
  };
  addEventListener('message', hear);
})();
</script>
</body>
</html>
`;
}

/**
 * What the gateway answers: a shell that holds the Artifact's page in a sandboxed `srcdoc` frame.
 * Loading a `srcdoc` is no request, so `frame-src 'none'` lets it be and refuses every later
 * navigation of the frame. Should one still get through, the frame is removed rather than kept:
 * a frame loads once, and its second load is taken for a navigation.
 *
 * That is why no page here is written over a loaded one with `document.open`: a document opened
 * and closed again loads again, and the shell would remove the frame it had just drawn in. So
 * with no `inner`, as for a web page and a slide in the panel, the shell makes the frame itself
 * out of the first source its parent posts. The source is the frame's `srcdoc`, bound by this
 * same policy and sandbox, and it loads once like any other.
 *
 * With an `inner` page that waits for its source (`once`), the shell hands its parent's first
 * message on to the frame, once it has loaded, and never another. The frame has no way to reach
 * the shell: a sandboxed frame navigates only itself and what is inside it.
 *
 * The editing shell (`always`) relays every message of its parent inward, and out only the edit
 * key of the frame's: the panel sees them come from this window, which is the frame it holds.
 * Nothing else the frame posts reaches the panel.
 *
 * `fullscreen` lets the frame take the whole screen when its reader asks for it. It changes
 * nothing of where the frame can go or what it can reach, and a frame inside it is not given it.
 */
function shell(
  title: string,
  inner: string | null,
  hears: 'nothing' | 'once' | 'always',
  fullscreen = false,
): string {
  const held =
    inner === null
      ? ''
      : `
<iframe id="artifact" sandbox="allow-scripts" referrerpolicy="no-referrer"${fullscreen ? ' allowfullscreen' : ''} srcdoc="${escaped(inner)}"></iframe>`;
  const made = `
  const hear = (event) => {
    const source = event.source === parent && event.data && event.data.${ARTIFACT_FRAME_MESSAGE};
    if (typeof source !== 'string') return;
    removeEventListener('message', hear);
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.srcdoc = source;
    hold(frame, () => {});
    document.body.append(frame);
  };
  addEventListener('message', hear);`;
  const relayed = `
  const frame = document.getElementById('artifact');
  let loaded = false;
  const waiting = [];
  const relay = () => {
    if (!loaded) return;
    for (const data of waiting.splice(0)) frame.contentWindow.postMessage(data, '*');
  };
  hold(frame, () => {
    loaded = true;
    relay();
  });${
    hears === 'nothing'
      ? ''
      : `
  const hear = (event) => {
    if (event.source !== parent || !event.data) return;
    ${hears === 'once' ? "removeEventListener('message', hear);" : ''}
    waiting.push(event.data);
    relay();
  };
  addEventListener('message', hear);`
  }${
    hears === 'always'
      ? `
  addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || !event.data) return;
    const said = event.data[${JSON.stringify(ARTIFACT_EDIT_MESSAGE)}];
    if (said) parent.postMessage({ [${JSON.stringify(ARTIFACT_EDIT_MESSAGE)}]: said }, '*');
  });`
      : ''
  }`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<title>${escaped(title)}</title>
<style>html, body, iframe { margin: 0; width: 100%; height: 100%; border: 0; display: block; }</style>
</head>
<body>${held}
<script>
(() => {
  const hold = (frame, ready) => {
    let loaded = false;
    frame.addEventListener('load', () => {
      if (loaded) return frame.remove();
      loaded = true;
      ready();
    });
  };${inner === null ? made : relayed}
})();
</script>
</body>
</html>
`;
}

const frames = new Map<string, string>();

/**
 * The empty frame of a type, the same for every Artifact and every owner. Built once. `editing`
 * is the one the owner edits by hand in, which only a page and a deck's slide have.
 */
export function artifactFrame(type: SessionArtifactType, editing = false): string {
  if (editing && !EDITABLE_ARTIFACT_TYPES.includes(type)) {
    throw new GatewayError(400, 'Only a web page or a deck is edited by hand.');
  }
  const key = `${type}:${editing}`;
  let frame = frames.get(key);

  if (!frame) {
    frame = editing
      ? shell('Artifact', page(type, undefined, true), 'always')
      : shell('Artifact', DRAW[type].whole ? null : page(type), 'once');
    frames.set(key, frame);
  }

  return frame;
}

/**
 * One Artifact as a page of its own, which is what a public link answers. Only a deck's frame may
 * take the whole screen, to be presented: that frame runs the gateway's own player, and each
 * slide, which is what the agent wrote, sits one frame further in with no such leave.
 */
export const publishedArtifact = (
  type: SessionArtifactType,
  title: string,
  source: string,
): string => shell(title, page(type, { title, source }), 'nothing', type === 'deck');
