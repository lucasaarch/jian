import {
  ARTIFACT_EDIT_MESSAGE,
  ARTIFACT_FRAME_MESSAGE,
  ARTIFACT_PRESENT_MESSAGE,
  ARTIFACT_THEME_MESSAGE,
  ARTIFACT_TWEAKS_MESSAGE,
  EDITABLE_ARTIFACT_TYPES,
  type SessionArtifactType,
} from '@jian/contracts';
import { GatewayError } from '../core/errors.js';
import { EDITORS } from './edit-frame.js';
import { type FrameTheme, frameStyle } from './frame-style.js';
import { PLAYER, PLAYER_EMBEDDED } from './player.js';
import { type RuntimeFile, runtimeSource } from './runtime.js';
import { SHEET } from './sheet-frame.js';

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
 * for none. One exception is the frame the owner opens to edit by hand (edit-frame.ts), which
 * runs nothing the agent wrote and answers the panel's request for the edited source; a public
 * link never serves it. The other is a component's tweaks (ARTIFACT_TWEAKS_MESSAGE): the shell
 * relays that key alone, and the panel takes it as data to draw fields from, checked first.
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
  // Drawn by scripts of the gateway's own, which read the source as data and never run it.
  sheet: { libraries: [], body: `${SHEET}\nsheet(source, root, false);` },
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
const exported = define('artifact', source);
const Component = exported.default;
if (!Component) throw new Error('The component must be the default export.');
// The props it is drawn with: each tweak's default, then what the owner sets in the panel.
const declared = exported.tweaks && typeof exported.tweaks === 'object' ? exported.tweaks : {};
const props = {};
for (const [key, spec] of Object.entries(declared)) {
  props[key] = spec && typeof spec === 'object' ? spec.default : spec;
}
// Centred on the canvas, unless the component paints a ground of its own over the view: on its
// root element, as wide or as tall as the view, or on the page's body. Decided once, before the
// first paint, so nothing moves after.
const grounds = (style) => style.backgroundColor + style.backgroundImage;
const ground = grounds(getComputedStyle(document.body));
const painted = (style) =>
  style.backgroundImage !== 'none' ||
  !(style.backgroundColor === 'transparent' || /,\\s*0\\)$/.test(style.backgroundColor));
const Frame = ({ children }) => {
  React.useLayoutEffect(() => {
    const own = root.firstElementChild;
    const box = getComputedStyle(root);
    const room = root.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight);
    const rect = own && own.getBoundingClientRect();
    const filled =
      grounds(getComputedStyle(document.body)) !== ground ||
      Boolean(own && painted(getComputedStyle(own)) &&
        (rect.width >= room - 1 || rect.height >= innerHeight - 1));
    document.body.classList.toggle('filled', filled);
  }, []);
  return children;
};
const view = createRoot(root);
const paint = () =>
  view.render(React.createElement(Frame, null, React.createElement(Component, { ...props })));
addEventListener('message', (event) => {
  const said = event.source === parent && event.data && event.data.${ARTIFACT_TWEAKS_MESSAGE};
  const values = said && said.values;
  if (!values || typeof values !== 'object') return;
  for (const key of Object.keys(declared)) if (Object.hasOwn(values, key)) props[key] = values[key];
  paint();
});
paint();
if (parent !== window) {
  // As plain data: a function or a cycle in it is the panel's to go without.
  let controls = null;
  try {
    controls = JSON.parse(JSON.stringify(declared));
  } catch {}
  parent.postMessage({ ${ARTIFACT_TWEAKS_MESSAGE}: { controls } }, '*');
}`,
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
 * (edit-frame.ts) and never runs it, so nothing the agent wrote runs in it.
 */
function page(
  type: SessionArtifactType,
  artifact?: { title: string; source: string },
  editing = false,
  presented = false,
  theme?: FrameTheme,
): string {
  const { libraries } = DRAW[type];
  const body = presented ? PLAYER_EMBEDDED : DRAW[type].body;

  return `<!doctype html>
<html lang="en"${theme === 'dark' ? ' class="dark"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escaped(artifact?.title ?? 'Artifact')}</title>
<style>${frameStyle(theme)}</style>${
    // A public link names no theme: its dark class follows the reader system, for the
    // Tailwind-style dark: variants a component may use.
    theme
      ? ''
      : `
<script>if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark');</script>`
  }
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
  // The panel's theme changed. Only its own window may say so, and it carries nothing else.
  addEventListener('message', (event) => {
    const theme = event.source === parent && event.data && event.data.${ARTIFACT_THEME_MESSAGE};
    if (theme !== 'dark' && theme !== 'light') return;
    document.documentElement.style.colorScheme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
  });
  // A script element made here runs at once, under the page's policy, with no eval.
  const run = (code) => {
    const script = document.createElement('script');
    script.textContent = code;
    document.head.append(script);
    script.remove();
  };
  const draw = async (source, libraries) => {
${editing ? '' : body}
  };${editing ? (EDITORS[type] ?? '') : ''}
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

/** One Artifact's page on its own, with no shell, for a file drawn from it (export.ts). */
export { page as artifactPage };

/**
 * What an HTML page is given ahead of its own markup in the panel, so it opens in the panel's
 * theme and never on the browser's white: its scheme, the dark class that Tailwind-style dark:
 * variants read, and a listener for the theme changing later. It goes after the doctype, which
 * stays first so the page is not drawn in quirks mode. The page's own styles come after and win,
 * so a page that sets a ground of its own keeps it.
 */
const dressing = (theme: FrameTheme) =>
  `<meta name="color-scheme" content="${theme}"><script>(() => {
const apply = (theme) => {
  document.documentElement.style.colorScheme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
};
apply('${theme}');
addEventListener('message', (event) => {
  const theme = event.source === parent && event.data && event.data.${ARTIFACT_THEME_MESSAGE};
  if (theme === 'dark' || theme === 'light') apply(theme);
});
})();</script>`;

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
 *
 * `tweaks` is a component's shell: it also relays the tweaks key, and only that key, both ways,
 * for as long as the frame lives (ARTIFACT_TWEAKS_MESSAGE).
 *
 * `sheet` paints the white a slide is drawn on, here, inside the frame the panel holds. The panel
 * rounds that frame's corners, and a white it painted under the frame itself was cut by the
 * corner apart from the slide: it showed past a dark slide as a pale arc. It is painted only once
 * the slide's frame has loaded (`drawn`): before that the frame is clear, so what the panel had
 * there stays, and a dark slide does not open on a flash of white.
 *
 * Any frame here is unseen until it has loaded (`drawn`) for the same reason: until then it holds
 * the browser's empty page, whose colour scheme is not the panel's, and the browser paints a
 * frame like that on an opaque canvas, white behind a dark panel.
 */
function shell(
  title: string,
  inner: string | null,
  hears: 'nothing' | 'once' | 'always' | 'present',
  {
    fullscreen = false,
    sheet = false,
    theme,
    dressed = false,
    tweaks = false,
  }: {
    fullscreen?: boolean;
    sheet?: boolean;
    theme?: FrameTheme | undefined;
    dressed?: boolean;
    tweaks?: boolean;
  } = {},
): string {
  const out = hears === 'present' ? ARTIFACT_PRESENT_MESSAGE : ARTIFACT_EDIT_MESSAGE;
  const held =
    inner === null
      ? ''
      : `
<iframe id="artifact" sandbox="allow-scripts" referrerpolicy="no-referrer"${fullscreen ? ' allowfullscreen' : ''} srcdoc="${escaped(inner)}"></iframe>`;
  // What is added goes after a leading doctype, which has to stay first.
  const dress = dressed
    ? `
  const dressing = ${embedded({ dark: dressing('dark'), light: dressing('light') })};
  const dress = (source) => {
    const at = (/^\\s*<!doctype[^>]*>/i.exec(source) || [''])[0].length;
    return source.slice(0, at) + (scheme ? dressing[scheme] : '') + source.slice(at);
  };`
    : '';
  // Only a frame the panel named a theme for listens for the theme: a public link follows the
  // reader's system and says nothing inward.
  const follows = theme
    ? `
  // The panel's theme: this frame's scheme, and what the page inside is told as it changes.
  let scheme = ${JSON.stringify(theme ?? null)};
  const tell = () => {
    if (!scheme) return;
    for (const held of document.querySelectorAll('iframe')) {
      if (held.contentWindow) held.contentWindow.postMessage({ ${ARTIFACT_THEME_MESSAGE}: scheme }, '*');
    }
  };
  addEventListener('message', (event) => {
    const given = event.source === parent && event.data && event.data.${ARTIFACT_THEME_MESSAGE};
    if (given !== 'dark' && given !== 'light') return;
    scheme = given;
    document.documentElement.style.colorScheme = given;
    tell();
  });${dress}`
    : '';
  const made = `
  const hear = (event) => {
    const source = event.source === parent && event.data && event.data.${ARTIFACT_FRAME_MESSAGE};
    if (typeof source !== 'string') return;
    removeEventListener('message', hear);
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.srcdoc = ${dressed ? 'dress(source)' : 'source'};
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
    loaded = true;${hears === 'present' ? '\n    frame.focus();' : ''}
    relay();
  });${
    hears === 'nothing'
      ? ''
      : `
  const hear = (event) => {
    if (event.source !== parent || !event.data${theme ? ` || event.data.${ARTIFACT_THEME_MESSAGE}` : ''}${tweaks ? ` || event.data.${ARTIFACT_TWEAKS_MESSAGE}` : ''}) return;
    ${hears === 'always' ? '' : "removeEventListener('message', hear);"}
    waiting.push(event.data);
    relay();
  };
  addEventListener('message', hear);`
  }${
    tweaks
      ? `
  addEventListener('message', (event) => {
    const said = event.data && event.data.${ARTIFACT_TWEAKS_MESSAGE};
    if (!said) return;
    if (event.source === parent) {
      waiting.push({ ${ARTIFACT_TWEAKS_MESSAGE}: said });
      relay();
    } else if (event.source === frame.contentWindow) {
      parent.postMessage({ ${ARTIFACT_TWEAKS_MESSAGE}: said }, '*');
    }
  });`
      : ''
  }${
    hears === 'always' || hears === 'present'
      ? `
  addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || !event.data) return;
    const said = event.data[${JSON.stringify(out)}];
    if (said) parent.postMessage({ [${JSON.stringify(out)}]: said }, '*');
  });`
      : ''
  }`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<title>${escaped(title)}</title>
<style>:root { color-scheme: ${theme ?? 'light dark'}; }
html, body, iframe { margin: 0; width: 100%; height: 100%; border: 0; display: block; }
html, body { background: transparent; }
html:not(.drawn) iframe { opacity: 0; }${sheet ? '\nhtml.drawn { background: #fff; }' : ''}</style>
</head>
<body>${held}
<script>
(() => {
${follows}
  const hold = (frame, ready) => {
    let loaded = false;
    frame.addEventListener('load', () => {
      if (loaded) return frame.remove();
      loaded = true;
      document.documentElement.classList.add('drawn');${theme ? '\n      tell();' : ''}
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
 * is the one the owner edits by hand in, which only `EDITABLE_ARTIFACT_TYPES` have. `present` is
 * a deck's player, already presenting, for the panel's own presentation of it.
 */
export function artifactFrame(
  type: SessionArtifactType,
  editing = false,
  present = false,
  theme?: FrameTheme,
): string {
  if (editing && !(EDITABLE_ARTIFACT_TYPES.includes(type) && EDITORS[type])) {
    throw new GatewayError(400, 'This kind of Artifact is not edited by hand.');
  }
  if (present && (type !== 'deck' || editing)) {
    throw new GatewayError(400, 'Only a deck is presented, and not while it is edited.');
  }
  const key = `${type}:${editing}:${present}:${theme ?? ''}`;
  let frame = frames.get(key);

  if (!frame) {
    frame = present
      ? shell('Artifact', page(type, undefined, false, true, theme), 'present', { theme })
      : editing
        ? shell('Artifact', page(type, undefined, true, false, theme), 'always', {
            sheet: type === 'deck',
            theme,
          })
        : shell(
            'Artifact',
            DRAW[type].whole ? null : page(type, undefined, false, false, theme),
            'once',
            {
              sheet: type === 'deck',
              theme,
              // A slide keeps its own page; only an HTML page takes the panel's theme.
              dressed: type === 'html' && theme !== undefined,
              tweaks: type === 'react',
            },
          );
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
): string =>
  shell(title, page(type, { title, source }), 'nothing', { fullscreen: type === 'deck' });
