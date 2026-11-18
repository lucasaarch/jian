import { ARTIFACT_FRAME_MESSAGE, type SessionArtifactType } from '@jian/contracts';
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
 * - No form is sent and no frame is opened inside it.
 *
 * `'unsafe-inline'` is the point, not a hole: the page exists to run the Artifact's own script.
 * `eval` stays refused, which none of the libraries needs.
 *
 * The page takes its source and gives nothing back: it posts no message, and the panel listens
 * for none.
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
    `frame-ancestors ${ancestors}`,
    'sandbox allow-scripts',
  ].join('; ');
}

const STYLE = `
:root { color-scheme: light dark; }
html, body { margin: 0; }
body { padding: 16px; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  overflow-wrap: anywhere; }
body.react { padding: 0; }
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
`;

/**
 * How each type is drawn, as the body of `async (source, libraries) => { … }` in the page, with
 * `root` and `run` in reach. `libraries` are the type's files below, in their order.
 */
const DRAW: Record<SessionArtifactType, { libraries: readonly RuntimeFile[]; body: string }> = {
  // A whole page takes the document's place. The policy came with the response and stays.
  html: {
    libraries: [],
    body: `document.open(); document.write(source); document.close();`,
  },
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

const escaped = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The page for one type. With no `artifact` it is the empty frame: it draws the first source its
 * parent posts to it, and only its parent's. With one it draws that, and listens to no one.
 */
function page(type: SessionArtifactType, artifact?: { title: string; source: string }): string {
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
${body}
  };
  const show = (source) => draw(source, read('libraries')).catch(fail);
  const given = read('artifact');
  if (given !== null) return show(given);
  const hear = (event) => {
    const source = event.source === parent && event.data && event.data.${ARTIFACT_FRAME_MESSAGE};
    if (typeof source !== 'string') return;
    removeEventListener('message', hear);
    show(source);
  };
  addEventListener('message', hear);
})();
</script>
</body>
</html>
`;
}

const frames = new Map<SessionArtifactType, string>();

/** The empty frame of a type, the same for every Artifact and every owner. Built once. */
export function artifactFrame(type: SessionArtifactType): string {
  let frame = frames.get(type);

  if (!frame) {
    frame = page(type);
    frames.set(type, frame);
  }

  return frame;
}

/** One Artifact as a page of its own, which is what a public link answers. */
export const publishedArtifact = (
  type: SessionArtifactType,
  title: string,
  source: string,
): string => page(type, { title, source });
