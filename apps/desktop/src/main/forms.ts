import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type PostBody, shell } from 'electron';

const asHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * A form the panel sends to another site in a new tab — GitHub's App registration posts its
 * manifest this way — sent from the system's browser instead: a page that submits the same
 * fields itself, opened there, and deleted once the browser had time to read it.
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
  const file = join(tmpdir(), `jian-form-${randomBytes(8).toString('hex')}.html`);
  await writeFile(file, page, { mode: 0o600 });
  await shell.openExternal(pathToFileURL(file).href);
  setTimeout(() => void rm(file, { force: true }), 60_000).unref();
}
