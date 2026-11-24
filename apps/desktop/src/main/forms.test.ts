import { expect, it, vi } from 'vitest';
import { submitInBrowser } from './forms';

const opened = vi.hoisted(() => [] as string[]);
vi.mock('electron', () => ({
  shell: { openExternal: async (url: string) => void opened.push(url) },
}));

const manifest = JSON.stringify({ name: 'Jian - 1a2b3c4d', url: 'http://127.0.0.1:37461' });

it('hands the browser an http page on loopback that posts the form, and serves it only once', async () => {
  await submitInBrowser('https://github.com/settings/apps/new?state=synthetic&x=1', {
    contentType: 'application/x-www-form-urlencoded',
    data: [{ type: 'rawData', bytes: Buffer.from(`manifest=${encodeURIComponent(manifest)}`) }],
  });

  // Never a file: Linux opens a file:// page with whatever takes .html, often a text editor.
  const url = new URL(opened.at(-1) ?? '');
  expect(url.protocol).toBe('http:');
  expect(url.hostname).toBe('127.0.0.1');
  expect(url.pathname).toMatch(/^\/[0-9a-f]{32}$/);

  expect((await fetch(new URL('/other', url))).status).toBe(404);
  const answer = await fetch(url);
  expect(answer.headers.get('content-type')).toBe('text/html; charset=utf-8');
  const page = await answer.text();
  expect(page).toContain(
    '<form method="post" action="https://github.com/settings/apps/new?state=synthetic&#38;x=1">',
  );
  expect(page).toContain(
    `<input type="hidden" name="manifest" value="${manifest.replaceAll('"', '&#34;')}">`,
  );
  expect(page).toContain('document.forms[0].submit()');

  const again = await fetch(url).then(
    (second) => second.status,
    () => 'closed',
  );
  expect(again).not.toBe(200);
});
