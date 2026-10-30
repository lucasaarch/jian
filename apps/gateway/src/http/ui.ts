import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    publicUiAsset?: boolean;
  }
}

/**
 * The gateway served the panel at /ui/ until the panel became its own container. An
 * installation updated without that container, a PaaS template above all, now reaches this
 * address and finds no panel; this page says what changed and how to finish the update.
 */
const GUIDE = 'https://github.com/lucasaarch/jian/blob/main/docs/releases/1.0.0.md#upgrading';

const STYLE = `
:root { color-scheme: dark light; --ink: #ededed; --muted: #a3a3a3; --line: #262626;
  --surface: #0f0f0f; --page: #050505; --accent: #f97316; }
@media (prefers-color-scheme: light) { :root { --ink: #171717; --muted: #525252;
  --line: #e5e5e5; --surface: #fafafa; --page: #ffffff; --accent: #c2410c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 4rem 1rem; }
.tag { color: var(--accent); font-size: .8rem; font-weight: 600; letter-spacing: .08em;
  text-transform: uppercase; margin: 0; }
h1 { font-size: 2rem; line-height: 1.2; margin: .5rem 0 1rem; }
h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
p, li { color: var(--muted); }
section { border: 1px solid var(--line); background: var(--surface); border-radius: .75rem;
  padding: 1.25rem; margin-top: 1rem; }
section p:last-child, section ol { margin-bottom: 0; }
ol { padding-left: 1.25rem; }
code { font: .875em ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink);
  overflow-wrap: anywhere; }
a { color: var(--accent); }
footer { margin-top: 2rem; font-size: .875rem; color: var(--muted); }
`;

const STYLE_HASH = `'sha256-${createHash('sha256').update(STYLE).digest('base64')}'`;

// Nothing on the page runs or loads: the one inline style is allowed by its hash.
const POLICY = [
  "default-src 'none'",
  `style-src ${STYLE_HASH}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );

function page(version: string | undefined) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Jian · The panel has moved</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="tag">Update required</p>
<h1>The panel has moved out of the gateway</h1>
<p>This gateway no longer serves the Jian panel. The panel now runs as its own container,
<code>ghcr.io/lucasaarch/jian-web</code>, placed in front of the gateway. The API, the channels,
webhooks and remote workers at this address keep working; only the panel is missing.</p>

<section>
<h2>Installed from a template (Cubeship or another platform)</h2>
<ol>
<li>Reinstall the Jian template, or update it to its latest version, so it adds the web service.</li>
<li>Keep this database and the same <code>JIAN_API_TOKEN</code>, <code>JIAN_ACTIVE_KEY_ID</code>
and <code>JIAN_MASTER_KEYS</code>: the gateway's data stays where it is.</li>
<li>Move this installation's domain from the gateway to the web service. The web service passes
<code>/v1</code> and <code>/health</code> on to the gateway, so the webhook and callback addresses
you already registered keep working.</li>
</ol>
</section>

<section>
<h2>Installed with Compose from the repository</h2>
<p>Run <code>git pull</code>, then <code>make pull</code> and <code>make up</code>. The panel opens on the same address as
before, now at its root.</p>
</section>

<section>
<h2>Running the image on your own</h2>
<p>Start <code>ghcr.io/lucasaarch/jian-web</code> at the same version with
<code>JIAN_GATEWAY_URL</code> pointing at this gateway, publish its port <code>3000</code> where the
gateway's used to be, and set <code>JIAN_TRUSTED_PROXIES</code> on the gateway.</p>
</section>

<p>Every step, including Kubernetes: <a href="${GUIDE}" rel="noreferrer">moving the panel out of the gateway</a>.</p>
${version ? `<footer>Gateway ${escapeHtml(version)}</footer>` : ''}
</main>
</body>
</html>
`;
}

/** A file under /ui/ (the old worker, a script chunk) gets a 404, never this page as HTML. */
const looksLikeFile = (url: string) => /\.[A-Za-z0-9]+$/.test(url.split('?')[0] ?? '');

export function registerPanelNotice(app: FastifyInstance) {
  const html = page(process.env.JIAN_VERSION?.replace(/^v/, ''));

  app.get('/robots.txt', { config: { publicUiAsset: true } }, async (_request, reply) =>
    reply
      .type('text/plain; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .send('User-agent: *\nDisallow: /\n'),
  );

  // The bare host is how people reached the panel.
  app.get('/', { config: { publicUiAsset: true } }, async (_request, reply) =>
    reply.redirect('/ui/'),
  );

  for (const path of ['/ui', '/ui/*']) {
    app.get(path, { config: { publicUiAsset: true } }, async (request, reply) => {
      // The service worker an earlier panel registered checks its script for updates; a 404
      // makes the browser drop the registration instead of keeping the old one.
      if (looksLikeFile(request.url)) {
        return reply.code(404).send({ error: 'Not found' });
      }

      return reply
        .type('text/html; charset=utf-8')
        .header('Content-Security-Policy', POLICY)
        .header('Cache-Control', 'no-store')
        .send(html);
    });
  }
}
