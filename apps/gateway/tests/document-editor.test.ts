import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ARTIFACT_EDIT_MESSAGE, ARTIFACT_FRAME_MESSAGE } from '@jian/contracts';
import { type Browser, chromium, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactFrame, artifactPolicy } from '../src/artifacts/document.js';

/**
 * A Markdown document written in the panel's editing frame, in a real browser: what the owner
 * types, picks from the menu or pastes is what the frame hands back as Markdown when the panel
 * asks, and a document opened and edited comes back as it was written plus the edit.
 */

const embedded = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');

describe.runIf(existsSync(process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? chromium.executablePath()))(
  'the document editor',
  () => {
    let server: Server;
    let browser: Browser;
    let origin: string;
    const handed = new Map<string, string>();

    beforeAll(async () => {
      server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://gateway.test');
        const [, kind, name = ''] = url.pathname.split('/');
        const send = (body: string, policy?: string) => {
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            ...(policy ? { 'content-security-policy': policy } : {}),
          });
          response.end(body);
        };
        if (kind === 'frame') {
          return send(artifactFrame('markdown', true, false, 'light'), artifactPolicy("'self'"));
        }
        // The panel's part, as artifact-frame.tsx and use-autosave.ts play it.
        if (kind === 'panel') {
          return send(`<!doctype html><body style="margin:0">
<iframe id="held" sandbox="allow-scripts" style="border:0;width:1000px;height:700px" src="/frame/markdown"></iframe>
<script>
const held = document.getElementById('held');
window.answers = [];
addEventListener('message', (event) => {
  const said = event.source === held.contentWindow && event.data.${ARTIFACT_EDIT_MESSAGE};
  if (said && 'collect' in said) window.answers.push(said);
});
window.collect = (nonce) =>
  held.contentWindow.postMessage({ ${ARTIFACT_EDIT_MESSAGE}: { collect: nonce } }, '*');
held.addEventListener('load', () => held.contentWindow.postMessage({
  ${ARTIFACT_FRAME_MESSAGE}: ${embedded(handed.get(name) ?? '')},
}, '*'), { once: true });
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

    /** The panel, and the document's page two frames in, drawn and ready to write in. */
    const open = async (name: string, source: string): Promise<[Page, Frame]> => {
      handed.set(name, source);
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      await page.goto(`${origin}/panel/${name}`);
      const depth = (frame: Frame | null): number => (frame ? 1 + depth(frame.parentFrame()) : 0);
      await expect.poll(() => page.frames().some((frame) => depth(frame) === 3)).toBe(true);
      const frame = page.frames().find((one) => depth(one) === 3) as Frame;
      await expect
        .poll(() => frame.evaluate(() => document.getElementById('root')?.isContentEditable))
        .toBe(true);
      return [page, frame];
    };
    const collect = async (page: Page) => {
      const nonce = Math.random().toString(36).slice(2);
      await page.evaluate(
        (said) => (window as never as { collect: (n: string) => void }).collect(said),
        nonce,
      );
      await expect
        .poll(() =>
          page.evaluate(
            (said) =>
              (window as never as { answers: { collect: string }[] }).answers.some(
                (answer) => answer.collect === said,
              ),
            nonce,
          ),
        )
        .toBe(true);
      const answer = await page.evaluate(
        (said) =>
          (window as never as { answers: { collect: string; html?: string }[] }).answers.find(
            (one) => one.collect === said,
          ),
        nonce,
      );
      return answer?.html;
    };
    const lines = (...all: string[]) => `${all.join('\n')}\n`;
    // Home scrolls on macOS; there the start of a line is Cmd+Left.
    const LINE_START = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';

    it('writes a whole document from nothing, with Markdown typed as shortcuts', async () => {
      const [page, frame] = await open('typed', '');
      // An empty document asks to be written in, and a click anywhere in it is a caret.
      expect(await frame.getAttribute('#root > p', 'data-jian-hint')).toMatch(/type ‘\/’/i);
      await frame.click('#root', { position: { x: 300, y: 400 } });
      const type = (text: string) => page.keyboard.type(text);
      const press = (key: string) => page.keyboard.press(key);

      await type('# Plan');
      await press('Enter');
      await type('Some **bold** words, *slanted* ones and `code` too.');
      await press('Enter');
      await type('- first');
      await press('Enter');
      await type('second');
      await press('Tab');
      await press('Enter');
      await press('Enter');
      await type('third');
      await press('Enter');
      await press('Enter');
      await type('[] call the bank');
      await press('Enter');
      await type('pay the rent');
      await press('Enter');
      await press('Enter');
      await type('1. one');
      await press('Enter');
      await type('two');
      await press('Enter');
      await press('Enter');
      await type('> A quote');
      await press('Enter');
      await press('Enter');
      await type('```ts');
      await press('Enter');
      await type('const a = 1;');
      await press('Enter');
      await type('const b = 2;');
      await press('ArrowDown');
      await type('---');
      await type('The end');

      expect(await collect(page)).toBe(
        lines(
          '# Plan',
          '',
          'Some **bold** words, *slanted* ones and `code` too.',
          '',
          '- first',
          '  - second',
          // Two lists that touch are one list in Markdown, so they are one here too.
          '- third',
          '- [ ] call the bank',
          '- [ ] pay the rent',
          '',
          '1. one',
          '2. two',
          '',
          '> A quote',
          '',
          '```ts',
          'const a = 1;',
          'const b = 2;',
          '```',
          '',
          '---',
          '',
          'The end',
        ),
      );
      await page.close();
    });

    it('inserts blocks from the slash menu, found by typing', async () => {
      const [page, frame] = await open('slash', 'Intro\n');
      await frame.click('#root p');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('/head');
      const menu = frame.locator('#jian-slash');
      await expect.poll(() => menu.isVisible()).toBe(true);
      expect(await menu.locator('.item .label').allTextContents()).toEqual([
        'Heading 1',
        'Heading 2',
        'Heading 3',
      ]);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      expect(await menu.isVisible()).toBe(false);
      await page.keyboard.type('Second');
      await page.keyboard.press('Enter');
      // A slash after a word is a menu too, and what it picks goes below that line.
      await page.keyboard.type('Cells /tabl');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Name');
      await page.keyboard.press('Tab');
      await page.keyboard.type('Cost');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.type('Rent');
      await page.keyboard.press('Tab');
      await page.keyboard.type('900');
      // The menu goes when nothing in it matches, and the slash stays a slash.
      await frame.click('#root > p:last-child');
      await page.keyboard.type('/divider');
      await page.keyboard.press('Enter');
      await page.keyboard.type('a/b /zzzzzz');
      expect(await menu.isVisible()).toBe(false);

      expect(await collect(page)).toBe(
        lines(
          'Intro',
          '',
          '## Second',
          '',
          'Cells',
          '',
          '| Name | Cost |  |',
          '| --- | --- | --- |',
          '| Rent | 900 |  |',
          '|  |  |  |',
          '',
          '---',
          '',
          'a/b /zzzzzz',
        ),
      );
      await page.close();
    });

    it('opens a rich document and hands it back as written, with the edit', async () => {
      const source = lines(
        '# Title',
        '',
        'Words with **bold**, *em*, ~~gone~~, `code` and a [link](https://example.test).',
        '',
        '## Lists',
        '',
        '- one',
        '  - nested',
        '    1. deep',
        '- two',
        '',
        '3. three',
        '4. four',
        '',
        '- [x] done',
        '- [ ] open',
        '  - [ ] nested task',
        '',
        '> Quoted **words**',
        '>',
        '> Second paragraph',
        '',
        '```js',
        'const x = 1;',
        '',
        'const y = 2;',
        '```',
        '',
        '| Left | Middle | Right |',
        '| :-- | :-: | --: |',
        '| a | b | c |',
        '',
        '---',
        '',
        '<div class="callout"><p>Remember <strong>this</strong></p></div>',
        '',
        'Last line',
      );
      const [page, frame] = await open('rich', source);
      await frame.click('#root > p:last-child');
      await page.keyboard.press('End');
      await page.keyboard.type('.');
      expect(await collect(page)).toBe(source.replace('Last line', 'Last line.'));
      await page.close();
    });

    it('ticks a to-do with a click, and keeps it ticked', async () => {
      const [page, frame] = await open('todo', lines('- [ ] milk', '- [x] eggs'));
      expect(await collect(page)).toBeUndefined();
      await frame.click('#root li:first-child input');
      await frame.click('#root li:last-child input');
      expect(await frame.isChecked('#root li:first-child input')).toBe(true);
      expect(await collect(page)).toBe(lines('- [x] milk', '- [ ] eggs'));
      await page.close();
    });

    it('undoes a shortcut back to what was typed, and redoes it', async () => {
      const [page, frame] = await open('undo', 'Start\n');
      await frame.click('#root p');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('## ');
      expect(await frame.locator('#root h2').count()).toBe(1);
      await page.keyboard.press('ControlOrMeta+z');
      expect(await frame.locator('#root h2').count()).toBe(0);
      expect(await frame.textContent('#root')).toContain('##');
      await page.keyboard.press('ControlOrMeta+Shift+z');
      expect(await frame.locator('#root h2').count()).toBe(1);
      await page.keyboard.type('Heading');
      await page.keyboard.press('ControlOrMeta+z');
      expect(await collect(page)).toBe(lines('Start'));
      await page.close();
    });

    it('lets a line out of its block with Backspace and Enter, as editors do', async () => {
      const [page, frame] = await open('keys', lines('# Heading', '', '- item'));
      // At the start of a heading, Backspace makes it a paragraph before anything is joined.
      await frame.click('#root h1');
      await page.keyboard.press(LINE_START);
      await page.keyboard.press('Backspace');
      // Enter on an empty item leaves the list for a paragraph.
      await frame.click('#root li');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('After');
      // A click below a code block at the end writes in a new paragraph after it.
      await page.keyboard.press('Enter');
      await page.keyboard.type('```');
      await page.keyboard.press('Enter');
      await page.keyboard.type('code');
      await frame.click('#root', { position: { x: 300, y: 650 } });
      await page.keyboard.type('Below');
      expect(await collect(page)).toBe(
        lines('Heading', '', '- item', '', 'After', '', '```', 'code', '```', '', 'Below'),
      );
      await page.close();
    });

    it('formats a selection from the bar and joins lines without styles', async () => {
      const [page, frame] = await open('bar', lines('# Big', '', 'one two three'));
      await frame.click('#root p');
      await page.keyboard.press('End');
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowLeft');
      const bar = frame.locator('#jian-bar');
      await expect.poll(() => bar.isVisible()).toBe(true);
      await bar.locator('[data-tool=bold]').click();
      await bar.locator('[data-tool=italic]').click();
      // Joined into the heading by Backspace: the words take the heading, and no style is
      // written into the page to keep their old size.
      await frame.click('#root p');
      await page.keyboard.press(LINE_START);
      await page.keyboard.press('Backspace');
      expect(await frame.locator('#root [style], #root span').count()).toBe(0);
      expect(await collect(page)).toBe(lines('# Bigone two ***three***'));
      await page.close();
    });

    it('pastes what Markdown can hold, and nothing of where it came from', async () => {
      const [page, frame] = await open('paste', 'Before\n');
      await frame.click('#root p');
      await page.keyboard.press('End');
      const paste = (data: Record<string, string>) =>
        frame.evaluate((given) => {
          const transfer = new DataTransfer();
          for (const [type, value] of Object.entries(given)) transfer.setData(type, value);
          document.getElementById('root')?.dispatchEvent(
            new ClipboardEvent('paste', {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true,
            }),
          );
        }, data);
      await paste({
        'text/html':
          '<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-1"><p style="color:red"><span style="font-weight:700;font-family:Comic Sans">Loud</span> words</p><ul><li><p><span>an item</span></p></li></ul><p><a href="javascript:alert(1)">bad</a> <a href="https://example.test" style="color:blue">good</a><img src="x" onerror="alert(1)"></p></b>',
      });
      await page.keyboard.type(' end');
      await paste({ 'text/plain': '## From text\n\n- a\n- b' });
      expect(await frame.locator('#root [style], #root [onerror], #root span').count()).toBe(0);
      expect(await collect(page)).toBe(
        lines(
          'Before**Loud** words',
          '',
          '- an item',
          '',
          'bad [good](https://example.test) end',
          '',
          '## From text',
          '',
          '- a',
          '- b',
        ),
      );
      await page.close();
    });
  },
);
