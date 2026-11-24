import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type PostBody, shell } from 'electron';

const asHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** How long the page waits for the browser to ask for it, in ms. */
const PAGE_LIFETIME_MS = 60_000;

/**
 * A form the panel sends to another site in a new tab — GitHub's App registration posts its
 * manifest this way — sent from the system's browser instead: a page that submits the same
 * fields itself, served once on this computer's loopback, at a path nobody else can guess.
 *
 * Trap: an http address, never a file. Linux opens a file:// link with whatever the desktop
 * associates with .html, often a text editor that shows the page's source; http always goes to
 * the browser.
 */
export async function submitInBrowser(action: string, body: PostBody): Promise<void> {
  if (body.contentType !== 'application/x-www-form-urlencoded') return;
  const encoded = body.data
    .map((part) => (part.type === 'rawData' ? Buffer.from(part.bytes).toString('utf8') : ''))
    .join('');
  const fields = [...new URLSearchParams(encoded)]
    .map(([name, value]) => `<input type="hidden" name="${asHtml(name)}" value="${asHtml(value)}">`)
    .join('');
  const page = `<!doctype html><meta charset="utf-8"><title>Opening…</title>
<form method="post" action="${asHtml(action)}">${fields}</form>
<script>document.forms[0].submit()</script>`;
  const path = `/${randomBytes(16).toString('hex')}`;
  let served = false;
  const server = createServer((request, response) => {
    if (served || request.method !== 'GET' || request.url !== path) {
      response.writeHead(404).end();
      return;
    }
    served = true;
    response
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        connection: 'close',
      })
      .end(page);
    server.close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  setTimeout(() => server.close(), PAGE_LIFETIME_MS).unref();
  const { port } = server.address() as AddressInfo;
  await shell.openExternal(`http://127.0.0.1:${port}${path}`);
}
