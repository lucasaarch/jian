import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ARTIFACT_EDIT_MESSAGE,
  ARTIFACT_FRAME_MESSAGE,
  ARTIFACT_THEME_MESSAGE,
  ARTIFACT_TWEAKS_MESSAGE,
  type SessionArtifactType,
} from '@jian/contracts';
import { type Browser, chromium, type Frame, type Page } from 'playwright';
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
  // A component as the gateway hands it over: compiled to CommonJS.
  react: `exports.default = () => React.createElement('p', null, 'A component');`,
  sheet: 'Item,Cost\nA,2\nB,3\nTotal,=SUM(B2:B3)*21\n',
  diagram: JSON.stringify({
    nodes: [
      { id: 'start', label: 'Start' },
      { id: 'check', label: 'Is it ready?', shape: 'diamond', color: 'blue' },
      { id: 'done', label: 'Done' },
    ],
    edges: [
      { from: 'start', to: 'check' },
      { from: 'check', to: 'done', label: 'yes' },
    ],
  }),
  mermaid: 'graph LR; A[Alpha] --> B[Beta]',
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
        if (kind === 'frame') {
          const theme = url.searchParams.get('theme') || null;
          return send(
            artifactFrame(
              type,
              url.searchParams.has('edit'),
              false,
              theme === null ? undefined : (theme as 'dark'),
            ),
            artifactPolicy("'self'"),
          );
        }
        if (kind === 'public') {
          const source = type === 'deck' ? DECK : (SOURCE[type] ?? '');
          return send(publishedArtifact(type, 'Shared', source), artifactPolicy("'none'"));
        }
        // The panel's part, as artifact-frame.tsx plays it: the frame, and its source once it loads.
        // Editing, it also asks for the edit (`collect`) and keeps what the frame answers, not the
        // notice that something changed, which comes unasked. `wait`
        // hands the source only when the test calls `hand`.
        if (kind === 'panel') {
          const edit = url.searchParams.has('edit');
          const wait = url.searchParams.has('wait');
          return send(`<!doctype html><body style="margin:0">
<iframe id="held" sandbox="allow-scripts" style="border:0;width:900px;height:600px" src="/frame/${url.searchParams.get('type')}?${edit ? 'edit=1&' : ''}theme=${url.searchParams.get('theme') ?? ''}"></iframe>
<script>
const held = document.getElementById('held');
window.answers = [];
window.tweaks = [];
addEventListener('message', (event) => {
  if (event.source !== held.contentWindow) return;
  const said = event.data.${ARTIFACT_EDIT_MESSAGE};
  if (said && 'collect' in said) window.answers.push(said);
  if (event.data.${ARTIFACT_TWEAKS_MESSAGE}) window.tweaks.push(event.data.${ARTIFACT_TWEAKS_MESSAGE});
});
window.tweak = (values) =>
  held.contentWindow.postMessage({ ${ARTIFACT_TWEAKS_MESSAGE}: { values } }, '*');
window.collect = (nonce) =>
  held.contentWindow.postMessage({ ${ARTIFACT_EDIT_MESSAGE}: { collect: nonce } }, '*');
window.hand = () => {
  held.contentWindow.postMessage({
    ${ARTIFACT_FRAME_MESSAGE}: ${embedded(handed.get(name))},
    ${edit ? `${ARTIFACT_EDIT_MESSAGE}: { scale: 1 },` : ''}
  }, '*');
};
${wait ? '' : "held.addEventListener('load', window.hand, { once: true });"}
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
    const inPanel = (name: string, type: SessionArtifactType, source: string, edit = false) => {
      handed.set(name, source);
      return open(`/panel/${name}?type=${type}${edit ? '&edit=1' : ''}`);
    };
    /** The page the owner edits in, two frames in: the shell's, then its own. */
    const editing = async (page: Page): Promise<Frame> => {
      const depth = (frame: Frame | null): number => (frame ? 1 + depth(frame.parentFrame()) : 0);
      await expect.poll(() => page.frames().some((frame) => depth(frame) === 3)).toBe(true);
      return page.frames().find((frame) => depth(frame) === 3) as Frame;
    };
    /** What the frame answers the panel's asking for the edit, as edit.ts asks. */
    const collect = async (page: Page, nonce: string) => {
      await page.evaluate(
        (said) => (window as never as { collect: (n: string) => void }).collect(said),
        nonce,
      );
      await expect
        .poll(() => page.evaluate(() => (window as never as { answers: unknown[] }).answers.length))
        .toBeGreaterThan(0);
      return page.evaluate(() => (window as never as { answers: unknown[] }).answers.pop());
    };

    it('draws in the panel what the panel hands its frame, and keeps it drawn', async () => {
      const drawn: Record<string, string> = {
        html: 'A page ran',
        deck: 'One slide ran',
        markdown: 'A document',
        react: 'A component',
        // Worked out by the sheet itself, which runs no code: (2 + 3) * 21.
        sheet: '105',
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

    it("follows the panel's theme, not the system's, and changes with it", async () => {
      // A dark panel on a light system: the frame must be dark all the way in, or the browser
      // paints an opaque white canvas behind it.
      for (const type of ['html', 'react', 'markdown'] as const) {
        handed.set(`theme-${type}`, SOURCE[type] ?? '');
        const page = await browser.newPage({ colorScheme: 'light' });
        await page.goto(`${origin}/panel/theme-${type}?type=${type}&theme=dark`);
        await expect
          .poll(() => read(page), { message: type })
          .toMatch(/A page ran|A component|A document/);
        const looks = async () =>
          (
            await Promise.all(
              page
                .frames()
                .filter((frame) => frame.parentFrame())
                .map((frame) =>
                  frame
                    .evaluate(
                      "getComputedStyle(document.documentElement).colorScheme + ',' + document.documentElement.classList.contains('dark')",
                    )
                    .catch(() => ''),
                ),
            )
          ).filter(Boolean);
        await expect.poll(async () => (await looks()).length, { message: type }).toBeGreaterThan(0);
        expect(await looks(), type).toSatisfy((all: string[]) =>
          all.every((look) => look.startsWith('dark,')),
        );
        // The page that runs in the frame carries the class that dark: variants read.
        expect(await looks(), type).toContain('dark,true');

        await page.evaluate(
          `document.getElementById('held').contentWindow.postMessage({ ${ARTIFACT_THEME_MESSAGE}: 'light' }, '*')`,
        );
        await expect
          .poll(async () => (await looks()).every((look) => look === 'light,false'), {
            message: type,
          })
          .toBe(true);
        await page.close();
      }
    });

    it("says a component's tweaks, draws it with the ones the panel sets, on its canvas", async () => {
      const page = await inPanel(
        'tweaks',
        'react',
        `exports.tweaks = { label: { type: 'text', default: 'Count' }, start: 3, kept: 'yes' };
exports.default = (props) =>
  React.createElement('p', { id: 'card', style: { width: '200px', margin: 0 } }, [props.label, props.start, props.kept, Object.keys(props).join('|')].join(' '));`,
      );
      const said = () => page.evaluate('window.tweaks');
      await expect
        .poll(said)
        .toEqual([
          { controls: { label: { type: 'text', default: 'Count' }, start: 3, kept: 'yes' } },
        ]);
      await expect.poll(() => read(page)).toContain('Count 3 yes label|start|kept');

      // Only the names it declared are taken: anything else the panel sends is left out.
      await page.evaluate("window.tweak({ label: 'Clicks', start: 9, other: 'no' })");
      await expect.poll(() => read(page)).toContain('Clicks 9 yes label|start|kept');
      const component = page.frames().at(-1) as Frame;

      // A component with no ground of its own stands in the middle of the dotted canvas.
      const placed = (frame: Frame) =>
        frame.evaluate(`(() => {
          const card = document.getElementById('root').firstElementChild.getBoundingClientRect();
          return { middle: Math.round(card.x + card.width / 2), filled: document.body.classList.contains('filled'), dots: getComputedStyle(document.body).backgroundImage.startsWith('radial-gradient') };
        })()`);
      expect(await placed(component)).toEqual({ middle: 450, filled: false, dots: true });
      await page.close();

      // One that paints the whole view fills it from the corner, with no canvas around it.
      const full = await inPanel(
        'tweaks-full',
        'react',
        `exports.default = () => React.createElement('main', { style: { background: '#123', minHeight: '100vh', width: '300px' } }, 'Full');`,
      );
      await expect.poll(() => read(full)).toContain('Full');
      expect(await placed(full.frames().at(-1) as Frame)).toEqual({
        middle: 150,
        filled: true,
        dots: false,
      });
      // A component that declares no tweaks still says so, with nothing.
      await expect.poll(() => full.evaluate('window.tweaks')).toEqual([{ controls: {} }]);
      await full.close();
    });

    it('lays a document out as a column of its own, which prints on the whole page', async () => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      await page.goto(`${origin}/public/markdown`);
      await expect.poll(() => read(page)).toContain('A document');
      const root = async () =>
        (await page
          .frames()
          .at(-1)
          ?.evaluate(
            "(() => { const r = document.getElementById('root'); return [r.getBoundingClientRect().width, getComputedStyle(r).maxWidth, getComputedStyle(document.documentElement).colorScheme]; })()",
          )) as [number, string, string];
      const [width, max] = await root();
      expect([width, max]).toEqual([704, '704px']);
      // Printed to PDF: the light scheme and no column, whatever the reader's system.
      await page.emulateMedia({ media: 'print', colorScheme: 'dark' });
      expect(await root()).toEqual([expect.any(Number), 'none', 'light']);
      await page.close();
    });

    it("keeps a slide's frame clear until the slide has drawn, then white under it", async () => {
      handed.set('deck-wait', SOURCE.deck ?? '');
      const page = await open('/panel/deck-wait?type=deck&wait=1');
      const shell = () => page.frames().find((frame) => frame.parentFrame() === page.mainFrame());
      await expect
        .poll(() =>
          shell()
            ?.evaluate(() => document.readyState)
            .catch(() => ''),
        )
        .toBe('complete');
      const ground = () =>
        (shell() as Frame).evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        );
      // Loaded and still waiting for its slide: nothing painted, so no white shows before a
      // dark slide does.
      expect(await ground()).toBe('rgba(0, 0, 0, 0)');

      await page.evaluate(() => (window as never as { hand: () => void }).hand());
      await expect.poll(() => read(page)).toContain('One slide ran');
      // A slide that sets no ground of its own is still drawn on white.
      expect(await ground()).toBe('rgb(255, 255, 255)');
      await page.close();
    });

    it('edits a spreadsheet cell by cell, works its formulas again, and hands back the CSV', async () => {
      const page = await inPanel('sheet-edit', 'sheet', SOURCE.sheet ?? '', true);
      const sheet = await editing(page);
      const cell = (at: string) => sheet.locator(`td[data-at="${at}"]`);
      await expect.poll(() => cell('3,1').textContent()).toBe('105');
      expect(await collect(page, 'untouched')).toEqual({ collect: 'untouched', unchanged: true });

      await cell('1,1').click();
      await page.keyboard.type('7');
      await page.keyboard.press('Enter');
      expect(await cell('3,1').textContent()).toBe('210');
      // The bar shows the cell picked as written, a formula included.
      await cell('3,1').click();
      expect(await sheet.locator('input[aria-label="Cell"]').inputValue()).toBe('=SUM(B2:B3)*21');

      expect(await collect(page, 'edited')).toEqual({
        collect: 'edited',
        html: 'Item,Cost\nA,7\nB,3\nTotal,=SUM(B2:B3)*21\n',
      });
      await page.close();
    });

    it('edits a document as it is drawn and hands back Markdown', async () => {
      const source = [
        '# Title',
        '',
        'Some **bold** text, a [link](https://example.test) and `code`.',
        '',
        '- one',
        '- two',
        '  1. nested',
        '',
        '| a | b |',
        '| :-: | --: |',
        '| 1 | 2 |',
        '',
        '> Quoted',
        '',
      ].join('\n');
      const page = await inPanel('markdown-edit', 'markdown', source, true);
      const document = await editing(page);

      await document.click('h1');
      // What the browser leaves on a block typed into in the panel, which says nothing.
      await document.evaluate("document.querySelector('h1').setAttribute('style', '')");
      await page.keyboard.press('End');
      await page.keyboard.type(' again');

      expect(await collect(page, 'written')).toEqual({
        collect: 'written',
        html: source.replace('# Title', '# Title again'),
      });
      await page.close();
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

    /** Where the drawing stands in its frame: the middle of what it covers, in the frame's pixels. */
    const middleOf = (frame: Frame, selector: string): Promise<[number, number]> =>
      frame.evaluate((picked): [number, number] => {
        const boxes = [...document.querySelectorAll(picked)].map((el) =>
          el.getBoundingClientRect(),
        );
        const left = Math.min(...boxes.map((box) => box.left));
        const right = Math.max(...boxes.map((box) => box.right));
        const top = Math.min(...boxes.map((box) => box.top));
        const bottom = Math.max(...boxes.map((box) => box.bottom));
        return [Math.round((left + right) / 2), Math.round((top + bottom) / 2)];
      }, selector);
    const innermost = (page: Page) => page.frames().at(-1) as Frame;

    it('draws a diagram and a Mermaid one centred on a dotted canvas, which pans and zooms', async () => {
      for (const [type, text, selector] of [
        ['diagram', 'Is it ready?', '.d-node'],
        ['mermaid', 'Alpha', '.canvas-world svg'],
      ] as const) {
        const page = await inPanel(`canvas-${type}`, type, SOURCE[type] ?? '');
        await expect.poll(() => read(page), { message: type }).toContain(text);
        const drawing = innermost(page);
        const [x, y] = await middleOf(drawing, selector);
        // The frame is 900 by 600, with a little more room kept at the bottom for the zoom.
        expect(Math.abs(x - 450), type).toBeLessThanOrEqual(2);
        expect(Math.abs(y - 292), type).toBeLessThanOrEqual(2);
        expect(
          await drawing.evaluate(
            () => getComputedStyle(document.getElementById('root') as Element).backgroundImage,
          ),
        ).toMatch(/^radial-gradient/);

        // Ctrl and the wheel zoom in around the pointer; the wheel alone pans.
        const box = await page.locator('#held').boundingBox();
        if (!box) throw new Error('No frame.');
        await page.mouse.move(box.x + 450, box.y + 292);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -100);
        await page.keyboard.up('Control');
        await expect
          .poll(() => drawing.locator('button[aria-label="Actual size"]').textContent())
          .not.toBe('100%');
        await page.mouse.wheel(0, 120);
        await expect
          .poll(async () => (await middleOf(drawing, selector))[1], { message: type })
          .toBeLessThan(250);
        await drawing.click('button[aria-label="Fit"]');
        await expect.poll(() => middleOf(drawing, selector)).toEqual([x, y]);
        await page.close();
      }
    });

    it('draws a public diagram for anyone, with nothing to edit it', async () => {
      const page = await open('/public/diagram');
      await expect.poll(() => read(page)).toContain('Is it ready?');
      const drawing = innermost(page);
      expect(await drawing.locator('.d-handle, .d-tools').count()).toBe(0);
      expect(await drawing.locator('button[aria-label="Zoom in"]').count()).toBe(1);
      await page.close();
    });

    it('edits a diagram by hand and hands back its JSON, every node placed', async () => {
      const page = await inPanel('diagram-edit', 'diagram', SOURCE.diagram ?? '', true);
      const drawing = await editing(page);
      await expect.poll(() => read(page)).toContain('Is it ready?');
      // Laid out where the agent left it to the layout, which is not an edit of the owner's.
      expect(await collect(page, 'untouched')).toEqual({ collect: 'untouched', unchanged: true });

      const box = await page.locator('#held').boundingBox();
      if (!box) throw new Error('No frame.');
      const centre = async (id: string) => {
        const [x, y] = await middleOf(drawing, `.d-node[data-id="${id}"]`);
        return [box.x + x, box.y + y] as const;
      };
      const kept = async (nonce: string) => {
        const answer = (await collect(page, nonce)) as { html: string };
        return JSON.parse(answer.html) as {
          nodes: { id: string; label: string; x: number; y: number; shape?: string }[];
          edges: { from: string; to: string; label?: string }[];
        };
      };

      // Dragged 100 pixels right at full size.
      const [sx, sy] = await centre('start');
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + 50, sy, { steps: 4 });
      await page.mouse.move(sx + 100, sy, { steps: 4 });
      await page.mouse.up();
      const [movedX, movedY] = await centre('start');
      expect([Math.round(movedX - sx), Math.round(movedY - sy)]).toEqual([100, 0]);
      let saved = await kept('moved');
      const start = saved.nodes.find((node) => node.id === 'start');
      const others = saved.nodes.filter((node) => node.id !== 'start');
      expect(others.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
      expect(start?.label).toBe('Start');

      // A double click on the canvas adds a node, written in place.
      await page.mouse.dblclick(box.x + 120, box.y + 520);
      await page.keyboard.type('Ship it');
      await page.keyboard.press('Enter');
      saved = await kept('added');
      const added = saved.nodes.find((node) => node.label === 'Ship it');
      expect(added).toMatchObject({ shape: 'rounded' });

      // A handle dragged onto another node joins them.
      const done = drawing.locator('.d-node[data-id="done"]');
      await done.hover();
      const handle = await done.locator('.d-handle[data-side="s"]').boundingBox();
      if (!handle || !added) throw new Error('No handle.');
      const [ax, ay] = await centre(added.id);
      await page.mouse.move(box.x + handle.x + 5, box.y + handle.y + 5);
      await page.mouse.down();
      await page.mouse.move(ax, ay - 10, { steps: 6 });
      await page.mouse.move(ax, ay, { steps: 2 });
      await page.mouse.up();
      saved = await kept('joined');
      expect(saved.edges).toContainEqual({ from: 'done', to: added.id });

      // The bar over a picked node changes its shape; Delete takes it away with its edges; undo
      // brings it back.
      // The line just drawn is picked, its bar over it; Escape lets go of it.
      expect(await drawing.locator('.d-bar').getAttribute('aria-label')).toBe('Edge');
      await page.keyboard.press('Escape');
      await page.mouse.click(...(await centre('done')));
      await drawing.click('.d-bar button[aria-label="Ellipse"]');
      saved = await kept('shaped');
      expect(saved.nodes.find((node) => node.id === 'done')?.shape).toBe('ellipse');
      await page.keyboard.press('Delete');
      saved = await kept('deleted');
      expect(saved.nodes.map((node) => node.id)).not.toContain('done');
      expect(saved.edges.some((edge) => edge.from === 'done' || edge.to === 'done')).toBe(false);
      await page.keyboard.press('Control+z');
      saved = await kept('undone');
      expect(saved.nodes.map((node) => node.id)).toContain('done');
      expect(saved.edges).toContainEqual({ from: 'check', to: 'done', label: 'yes' });
      await page.close();
    });
  },
);
