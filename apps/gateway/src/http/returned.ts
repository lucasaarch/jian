import { githubReturnPathSchema } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';

/**
 * Where GitHub sends the owner's browser back to a gateway a desktop app runs. Its panel is the
 * app, which a browser cannot open at an address, so this page says how it went and offers to
 * open the app, at the same place with the same outcome: `jian://open/<path>?<query>`.
 */
export function registerReturnPages(app: FastifyInstance): void {
  for (const path of githubReturnPathSchema.options) {
    app.get<{ Querystring: Record<string, string> }>(
      path,
      { config: { publicUiAsset: true } },
      async (request, reply) => {
        const query = new URLSearchParams(request.query).toString();
        const back = `jian://open${path}${query ? `?${query}` : ''}`;
        return reply
          .type('text/html; charset=utf-8')
          .header('Cache-Control', 'no-store')
          .send(page(outcome(request.query), back));
      },
    );
  }
}

function outcome(query: Record<string, string>): { title: string; text: string } {
  if (query.x === 'connected') {
    return { title: 'X account connected', text: 'Every agent can use it now.' };
  }
  if (query.x) {
    return { title: 'X did not finish connecting', text: 'Open Jian to see why and try again.' };
  }

  const result = query.github;

  if (result === 'registered') {
    return { title: 'GitHub App registered', text: 'Open Jian to connect your GitHub accounts.' };
  }
  if (result === 'connected') {
    return { title: 'GitHub account connected', text: 'Its repositories are ready in Jian.' };
  }
  return { title: 'GitHub did not finish connecting', text: 'Open Jian to see why and try again.' };
}

const asHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The panel's look with none of its files, as a gateway does not serve the panel: one pane of glass
 * and a pill. These values are `packages/ui/src/styles/themes.css`'s, and change with it.
 */
function page({ title, text }: { title: string; text: string }, back: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${asHtml(title)} · Jian</title>
<style>
:root { color-scheme: dark light; --canvas: #050505; --ink: #f5f5f3; --muted: #a6a6a3;
  --accent: #f5f5f3; --accent-hover: #dededb; --on-accent: #050505;
  --glass-strong: color-mix(in srgb, #141414 78%, transparent);
  --glass-edge: color-mix(in srgb, #ffffff 9%, transparent);
  --glass-light: color-mix(in srgb, #ffffff 7%, transparent);
  --glass-shadow: 0 18px 48px -16px rgb(0 0 0 / .65), 0 2px 8px -2px rgb(0 0 0 / .4); }
@media (prefers-color-scheme: light) { :root { --canvas: #f7f7f5; --ink: #171716; --muted: #686864;
  --accent: #171716; --accent-hover: #3d3d39; --on-accent: #ffffff;
  --glass-strong: color-mix(in srgb, #ffffff 82%, transparent);
  --glass-edge: color-mix(in srgb, #000000 8%, transparent);
  --glass-light: color-mix(in srgb, #ffffff 70%, transparent);
  --glass-shadow: 0 18px 48px -16px rgb(0 0 0 / .18), 0 2px 8px -2px rgb(0 0 0 / .08); } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem;
  background: var(--canvas); color: var(--ink);
  font: 14px/1.6 "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
main { display: grid; gap: 1.25rem; width: min(28rem, 100%); padding: 1.75rem;
  background: var(--glass-strong); border: 1px solid var(--glass-edge); border-radius: 1.375rem;
  box-shadow: inset 0 1px 0 var(--glass-light), var(--glass-shadow); }
h1 { margin: 0 0 .375rem; font-size: 1.125rem; line-height: 1.4; font-weight: 600;
  letter-spacing: -.015em; }
p { margin: 0; color: var(--muted); }
a { justify-self: end; display: inline-flex; align-items: center; height: 2.25rem; padding: 0 1rem;
  border-radius: 9999px; background: var(--accent); color: var(--on-accent); font-weight: 500;
  text-decoration: none; transition: background-color .15s; }
a:hover { background: var(--accent-hover); }
</style></head><body><main>
<div><h1>${asHtml(title)}</h1><p>${asHtml(text)}</p></div>
<a href="${asHtml(back)}">Open Jian</a>
</main></body></html>`;
}
