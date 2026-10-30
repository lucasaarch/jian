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
          .send(page(outcome(request.query.github), back));
      },
    );
  }
}

function outcome(result: string | undefined): { title: string; text: string } {
  if (result === 'registered') {
    return { title: 'GitHub App registered', text: 'Open Jian to connect your GitHub accounts.' };
  }
  if (result === 'connected') {
    return { title: 'GitHub account connected', text: 'Its repositories are ready in Jian.' };
  }
  return { title: 'GitHub did not finish connecting', text: 'Open Jian to see why and try again.' };
}

const asHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page({ title, text }: { title: string; text: string }, back: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${asHtml(title)} · Jian</title>
<style>
:root { color-scheme: dark light; --ink: #f5f5f3; --muted: #a6a6a3; --page: #050505; }
@media (prefers-color-scheme: light) { :root { --ink: #171716; --muted: #686864; --page: #f7f7f5; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--page);
  color: var(--ink); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 26rem; padding: 2rem 1.25rem; text-align: center; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
p { color: var(--muted); margin: 0 0 1.5rem; }
a { display: inline-block; padding: .7rem 1.2rem; border-radius: .5rem; background: var(--ink);
  color: var(--page); font-weight: 600; text-decoration: none; }
</style></head><body><main>
<h1>${asHtml(title)}</h1><p>${asHtml(text)}</p>
<a href="${asHtml(back)}">Open Jian</a>
</main></body></html>`;
}
