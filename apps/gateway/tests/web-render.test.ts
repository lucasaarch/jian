import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { isClaudeArtifact, readClaudeArtifact } from '../src/web/render.js';

it('recognizes only official public artifact viewers', () => {
  for (const url of [
    'https://claude.ai/artifact/short',
    'https://claude.ai/public/artifacts/id',
    'https://claude.site/artifacts/id',
    'https://claude.ai/code/artifact/id',
  ])
    expect(isClaudeArtifact(url)).toBe(true);
  for (const url of [
    'https://claude.ai.example.com/artifact/id',
    'https://claude.ai/chat/id',
    'http://claude.ai/artifact/id',
  ])
    expect(isClaudeArtifact(url)).toBe(false);
});

// Production images include Chromium. A source checkout can run these with `playwright install chromium`.
describe.runIf(existsSync(process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? chromium.executablePath()))(
  'rendered public artifacts',
  () => {
    it('reads script-created frames and routes redirects and scripts through the guarded transport', async () => {
      const requests: string[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push(url);
        expect(init?.redirect).toBe('manual');
        expect(new Headers(init?.headers).get('cookie')).toBeNull();
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        if (url === 'https://claude.ai/artifact/test')
          return new Response(
            '<title>Atlas plan</title><body><script src="https://assets.example.test/viewer.js"></script>',
            { headers: { 'content-type': 'text/html', 'set-cookie': 'private=synthetic' } },
          );
        if (url === 'https://assets.example.test/viewer.js')
          return new Response(
            `const f=document.createElement('iframe'); f.src='https://example.claudeusercontent.com/content'; document.body.append(f); fetch('https://example.test/write', {method:'POST'}); new WebSocket('wss://example.test/socket');`,
            { headers: { 'content-type': 'application/javascript' } },
          );
        if (url === 'https://example.claudeusercontent.com/content')
          return new Response(null, {
            status: 302,
            headers: { location: 'https://example.claudeusercontent.com/actual' },
          });
        if (url === 'https://example.claudeusercontent.com/actual')
          return new Response(
            '<body><div id="content"></div><script>document.getElementById("content").textContent="The complete artifact plan."; fetch("http://127.0.0.1/private").catch(()=>{});</script></body>',
            { headers: { 'content-type': 'text/html' } },
          );
        // The production transport rejects private destinations; none may fall back to browser networking.
        throw new Error('Outbound endpoint is not permitted');
      };
      const page = await readClaudeArtifact(
        'https://claude.ai/artifact/test',
        fetcher,
        AbortSignal.timeout(15_000),
      );
      expect(page).toMatchObject({ title: 'Atlas plan', text: 'The complete artifact plan.' });
      expect(requests).toContain('https://example.claudeusercontent.com/actual');
      expect(requests).toContain('http://127.0.0.1/private');
      expect(requests).not.toContain('https://example.test/write');
      expect(requests).not.toContain('wss://example.test/socket');
    });

    it('does not present a challenge in the content frame as the artifact', async () => {
      const fetcher: typeof fetch = async (input) =>
        String(input).includes('claudeusercontent.com')
          ? new Response('<body>Verify you are human</body>', {
              status: 403,
              headers: { 'content-type': 'text/html' },
            })
          : new Response(
              '<body><iframe src="https://example.claudeusercontent.com/content"></iframe></body>',
              { headers: { 'content-type': 'text/html' } },
            );
      await expect(
        readClaudeArtifact('https://claude.ai/artifact/test', fetcher, AbortSignal.timeout(10_000)),
      ).rejects.toThrow('artifact content did not load');
    });

    it('says where to go next when the viewer itself answers with a challenge', async () => {
      const fetcher: typeof fetch = async () =>
        new Response('<body>Verify you are human</body>', {
          status: 403,
          headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
        });
      await expect(
        readClaudeArtifact('https://claude.ai/artifact/test', fetcher, AbortSignal.timeout(10_000)),
      ).rejects.toThrow('Jian desktop app');
    });

    it('reports inaccessible content instead of presenting the viewer shell as the artifact', async () => {
      const fetcher: typeof fetch = async () =>
        new Response('<title>Claude Artifact</title><p>Loading...</p>', {
          headers: { 'content-type': 'text/html' },
        });
      await expect(
        readClaudeArtifact('https://claude.ai/artifact/test', fetcher, AbortSignal.timeout(10_000)),
      ).rejects.toThrow('artifact content did not load');
    });
  },
);
