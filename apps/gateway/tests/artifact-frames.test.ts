import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ARTIFACT_FRAME_MESSAGE, type SessionArtifactType } from '@jian/contracts';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactFrame, artifactPolicy, publishedArtifact } from '../src/artifacts/document.js';

/**
 * The Artifact pages in a real browser. What they are made of is checked as text elsewhere
 * (session-artifacts.test.ts); whether a frame ends up drawn is something only a browser says,
 * and a frame that was removed the moment it drew once passed every test that read its markup.
 */

const slide = (text: string) =>
  `<!doctype html><html><head><style>body { margin: 0; background: #123; color: #fff; }</style></head><body><h1></h1><script>document.querySelector('h1').textContent = '${text} ran'</script></body></html>`;

const SOURCE: Partial<Record<SessionArtifactType, string>> = {
  html: slide('A page'),
  deck: slide('One slide'),
  markdown: '# A document',
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><text y="20">A picture</text></svg>',
  // A component as the gateway hands it over: compiled to CommonJS.
  react: `exports.default = () => React.createElement('p', null, 'A component');`,
};
const DECK = JSON.stringify({ slides: [slide('First'), slide('Second'), slide('Third')] });

const embedded = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');

/** What every frame of the page reads as, the frames inside frames included. */
const read = async (page: Page) =>
  (
    await Promise.all(
      page.frames().map((frame) =>
        frame
          .evaluate(() => document.body?.innerText ?? '')
          // A frame on its way in or out has nothing to say yet.
          .catch(() => ''),
      ),
    )
  ).join('\n');

// Production images include Chromium. A source checkout can run these with `playwright install chromium`.
describe.runIf(existsSync(process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? chromium.executablePath()))(
  'an Artifact in a browser',
  () => {
    let server: Server;
    let browser: Browser;
    let origin: string;
    const asked: string[] = [];
    // What the panel hands the frame, by the name its address asks with.
    const handed = new Map<string, string>();

    beforeAll(async () => {
      server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://gateway.test');
        const [, kind, name = ''] = url.pathname.split('/');
        const type = name as SessionArtifactType;
        const send = (body: string, policy?: string) => {
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            ...(policy ? { 'content-security-policy': policy } : {}),
          });
          response.end(body);
        };

        asked.push(url.pathname);
        if (kind === 'frame') return send(artifactFrame(type), artifactPolicy("'self'"));
        if (kind === 'public') {
          const source = type === 'deck' ? DECK : (SOURCE[type] ?? '');
          return send(publishedArtifact(type, 'Shared', source), artifactPolicy("'none'"));
        }
        // The panel's part, as artifact-frame.tsx plays it: the frame, and its source once it loads.
        if (kind === 'panel') {
          return send(`<!doctype html><body>
<iframe id="held" sandbox="allow-scripts" src="/frame/${url.searchParams.get('type')}"></iframe>
<script>
const held = document.getElementById('held');
held.addEventListener('load', () => {
  held.contentWindow.postMessage({ ${ARTIFACT_FRAME_MESSAGE}: ${embedded(handed.get(name))} }, '*');
}, { once: true });
</script></body>`);
        }
        response.writeHead(404).end();
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
      browser = await chromium.launch(executablePath ? { executablePath } : {});
    });

    afterAll(async () => {
      await browser?.close();
      await new Promise((done) => server.close(done));
    });

    const open = async (path: string) => {
      const page = await browser.newPage();
      await page.goto(`${origin}${path}`);
      return page;
    };
    const inPanel = (name: string, type: SessionArtifactType, source: string) => {
      handed.set(name, source);
      return open(`/panel/${name}?type=${type}`);
    };

    it('draws in the panel what the panel hands its frame, and keeps it drawn', async () => {
      const drawn: Record<string, string> = {
        html: 'A page ran',
        deck: 'One slide ran',
        markdown: 'A document',
        svg: 'A picture',
        react: 'A component',
      };

      for (const [type, text] of Object.entries(drawn)) {
        const page = await inPanel(type, type as SessionArtifactType, SOURCE[type as 'html'] ?? '');
        await expect.poll(() => read(page), { message: type }).toContain(text);
        // Still there once everything has settled: a frame taken away after it drew is white.
        await page.waitForTimeout(300);
        expect(await read(page), type).toContain(text);
        await page.close();
      }
    });

    it('lets a page in the panel go nowhere', async () => {
      const leaving = [
        `<p>By script</p><script>location = '${origin}/away/script'</script>`,
        `<meta http-equiv="refresh" content="0;url=${origin}/away/refresh"><p>By refresh</p>`,
      ];

      for (const [index, source] of leaving.entries()) {
        const page = await inPanel(`leaving-${index}`, 'html', source);
        await page.waitForTimeout(600);
        await page.close();
      }
      expect(asked.filter((path) => path.startsWith('/away'))).toEqual([]);
    });

    it('draws a public page and a public deck, which is stepped through and presented', async () => {
      const page = await open('/public/html');
      await expect.poll(() => read(page)).toContain('A page ran');
      await page.close();

      const deck = await open('/public/deck');
      await expect.poll(() => read(deck)).toContain('First ran');
      const player = deck.frames().find((frame) => frame.parentFrame() === deck.mainFrame());
      if (!player) throw new Error('The deck has no player.');
      const state = () =>
        player.evaluate(() => ({
          count: document.getElementById('count')?.textContent,
          presenting: document.body.classList.contains('presenting'),
          // One slide is kept once the one before it has gone.
          slides: document.querySelectorAll('#sheet iframe').length,
        }));
      const settled = (count: string, presenting: boolean) =>
        expect.poll(state).toEqual({ count, presenting, slides: 1 });

      await player.click('button[aria-label="Next slide"]');
      await settled('2 / 3', false);
      await expect.poll(() => read(deck)).toContain('Second ran');

      await player.click('#present');
      await settled('2 / 3', true);
      await deck.keyboard.press('ArrowRight');
      await settled('3 / 3', true);
      await deck.keyboard.press('ArrowLeft');
      await settled('2 / 3', true);
      // Presented, a click anywhere on the slide moves on, and never lands in the slide.
      await deck.mouse.click(200, 200);
      await settled('3 / 3', true);
      await deck.keyboard.press('Escape');
      await settled('3 / 3', false);
      await deck.close();
    });
  },
);
