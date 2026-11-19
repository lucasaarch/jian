import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ARTIFACT_EDIT_MESSAGE, ARTIFACT_FRAME_MESSAGE } from '@jian/contracts';
import { type Browser, chromium, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactFrame, artifactPolicy, publishedArtifact } from '../src/artifacts/document.js';

/**
 * A spreadsheet edited by hand, in a real browser, the way the owner does it: the keys, the
 * pointer, the menu of a cell, and the CSV the panel collects at the end.
 */

const SOURCE =
  'Item,Qty,Price,Total\nPens,2,3,=B2*C2\nPads,1,4,=B3*C3\nSum,=SUM(B2:B3),,=SUM(D2:D3)\n';

describe.runIf(existsSync(process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? chromium.executablePath()))(
  'a spreadsheet edited by hand',
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
          return send(artifactFrame('sheet', true, false, 'light'), artifactPolicy("'self'"));
        }
        if (kind === 'public') {
          return send(
            publishedArtifact('sheet', 'Shared', handed.get(name) ?? ''),
            artifactPolicy("'none'"),
          );
        }
        // The panel's part, as artifact-frame.tsx plays it: the frame, its source once it
        // loads, and asking for the edit when the test does.
        return send(`<!doctype html><body style="margin:0">
<iframe id="held" sandbox="allow-scripts" style="border:0;width:900px;height:600px" src="/frame/sheet"></iframe>
<script>
const held = document.getElementById('held');
window.answers = [];
addEventListener('message', (event) => {
  const said = event.data.${ARTIFACT_EDIT_MESSAGE};
  if (event.source === held.contentWindow && said && 'collect' in said) window.answers.push(said);
});
window.collect = (nonce) =>
  held.contentWindow.postMessage({ ${ARTIFACT_EDIT_MESSAGE}: { collect: nonce } }, '*');
held.addEventListener('load', () => held.contentWindow.postMessage({
  ${ARTIFACT_FRAME_MESSAGE}: ${JSON.stringify(handed.get(name) ?? '').replaceAll('<', '\\u003c')},
  ${ARTIFACT_EDIT_MESSAGE}: { scale: 1 },
}, '*'), { once: true });
</script></body>`);
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

    /** The sheet's own frame, two in: the shell's, then its own. */
    const opened = async (name: string, source = SOURCE) => {
      handed.set(name, source);
      const page = await browser.newPage();
      await page.goto(`${origin}/panel/${name}`);
      const depth = (frame: Frame | null): number => (frame ? 1 + depth(frame.parentFrame()) : 0);
      await expect.poll(() => page.frames().some((frame) => depth(frame) === 3)).toBe(true);
      const sheet = page.frames().find((frame) => depth(frame) === 3) as Frame;
      await expect.poll(() => sheet.locator('td[data-at="0,0"]').textContent()).toBe('Item');
      return { page, sheet, cell: (at: string) => sheet.locator(`td[data-at="${at}"]`) };
    };
    const collect = async (page: Page, nonce: string) => {
      await page.evaluate(`window.collect(${JSON.stringify(nonce)})`);
      await expect.poll(() => page.evaluate('window.answers.length')).toBeGreaterThan(0);
      return page.evaluate('window.answers.pop()');
    };
    const editor = (sheet: Frame) => sheet.locator('[aria-label="Edit cell"]');
    const writing = (sheet: Frame) =>
      sheet.evaluate(() => document.querySelector('.sheet-scroll')?.classList.contains('writing'));

    it('writes a cell in place, as in Excel, and the panel collects it', async () => {
      const { page, sheet, cell } = await opened('in-place');

      // A double click opens the cell with what is written in it, the formula and not its value.
      await cell('1,3').dblclick();
      expect(await writing(sheet)).toBe(true);
      expect(await editor(sheet).inputValue()).toBe('=B2*C2');
      // Escape puts it back as it was.
      await page.keyboard.type('+100');
      await page.keyboard.press('Escape');
      expect(await writing(sheet)).toBe(false);
      expect(await cell('1,3').textContent()).toBe('6');

      // Typing on a picked cell writes over it; Enter keeps it and goes down.
      await cell('1,1').click();
      await page.keyboard.type('5');
      expect(await writing(sheet)).toBe(true);
      await page.keyboard.press('Enter');
      expect(await cell('1,3').textContent()).toBe('15');
      expect(await cell('3,1').textContent()).toBe('6');
      expect(await sheet.locator('.sheet-name').textContent()).toBe('B3');

      // Tab goes right, and Enter after a run of Tabs back to the column it began in.
      await page.keyboard.type('3');
      await page.keyboard.press('Tab');
      await page.keyboard.type('7');
      await page.keyboard.press('Enter');
      expect(await cell('2,3').textContent()).toBe('21');
      expect(await sheet.locator('.sheet-name').textContent()).toBe('B4');

      // F2 opens the cell to change it; a click elsewhere keeps what was written.
      await cell('0,0').click();
      await page.keyboard.press('F2');
      await page.keyboard.type(' bought');
      await cell('5,5').click();
      expect(await cell('0,0').textContent()).toBe('Item bought');

      expect(await collect(page, 'edited')).toEqual({
        collect: 'edited',
        html: 'Item bought,Qty,Price,Total\nPens,5,3,=B2*C2\nPads,3,7,=B3*C3\nSum,=SUM(B2:B3),,=SUM(D2:D3)\n',
      });
      await page.close();
    });

    it('puts a formula reference in with a click while the formula is written', async () => {
      const { page, sheet, cell } = await opened('pointing');
      await cell('5,0').click();
      await page.keyboard.type('=');
      await cell('1,1').click();
      // A second click before typing on takes the place of the first.
      await cell('1,2').click();
      await page.keyboard.type('*');
      await cell('1,1').hover();
      await page.mouse.down();
      await cell('2,1').hover();
      await page.mouse.up();
      expect(await editor(sheet).inputValue()).toBe('=C2*B2:B3');
      await page.keyboard.press('Escape');
      await page.close();
    });

    it('puts rows and columns in and takes them out, the formulas following', async () => {
      const { page, sheet, cell } = await opened('reshape');
      const menu = (label: string) => sheet.getByRole('menuitem', { name: label });

      // A row put in above Pads pushes it down, and the sums reach over it.
      await sheet.locator('th[data-row="2"]').click({ button: 'right' });
      await menu('Insert 1 row above').click();
      expect(await cell('2,0').textContent()).toBe('');
      await cell('2,0').click();
      await page.keyboard.type('Pins');
      await page.keyboard.press('Tab');
      await page.keyboard.type('10');
      await page.keyboard.press('Tab');
      await page.keyboard.type('1');
      await page.keyboard.press('Enter');
      expect(await cell('4,1').textContent()).toBe('13');

      // A column taken out leaves #REF! where a formula read it.
      await cell('1,2').click({ button: 'right' });
      await menu('Delete column C').click();
      expect(await cell('1,2').textContent()).toBe('#REF!');

      expect(await collect(page, 'reshaped')).toEqual({
        collect: 'reshaped',
        html: 'Item,Qty,Total\nPens,2,=B2*#REF!\nPins,10\nPads,1,=B4*#REF!\nSum,=SUM(B2:B4),=SUM(C2:C4)\n',
      });

      // Undo goes back a step at a time, and Redo forward again.
      await page.keyboard.press('ControlOrMeta+z');
      expect(await cell('1,3').textContent()).toBe('6');
      await page.keyboard.press('ControlOrMeta+z');
      expect(await cell('2,2').textContent()).toBe('');
      await page.keyboard.press('ControlOrMeta+Shift+z');
      expect(await cell('2,2').textContent()).toBe('1');
      await page.close();
    });

    it('clears, copies and pastes a range, a formula moving with it', async () => {
      const { page, sheet, cell } = await opened('ranges');
      await cell('1,3').click();
      await cell('2,3').click({ modifiers: ['Shift'] });
      expect(await sheet.locator('.sheet-name').textContent()).toBe('D2:D3');

      // What the clipboard is handed, as a paste reads it back.
      const copied = await sheet.evaluate(() => {
        const data = new DataTransfer();
        document.activeElement?.dispatchEvent(
          new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
        );
        return [data.getData('text/plain'), data.getData('application/x-jian-sheet')];
      });
      expect(copied[0]).toBe('6\n4');

      await cell('1,5').click();
      await sheet.evaluate((ours) => {
        const data = new DataTransfer();
        data.setData('text/plain', '6\n4');
        data.setData('application/x-jian-sheet', ours);
        document.activeElement?.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      }, copied[1] as string);
      await cell('2,5').click();
      expect(await sheet.locator('[aria-label="Cell"]').inputValue()).toBe('=D3*E3');

      // From another program, text with tabs lands as it is.
      await cell('6,0').click();
      await sheet.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', 'Tape\t4\r\nGlue\t2\r\n');
        document.activeElement?.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      });
      expect(await cell('7,1').textContent()).toBe('2');

      await cell('7,1').click();
      await page.keyboard.press('Backspace');
      expect(await collect(page, 'pasted')).toMatchObject({
        html: expect.stringContaining('\n\n\nTape,4\nGlue\n'),
      });
      await page.close();
    });

    it('draws a shared sheet to read, its numbers at ten digits at most', async () => {
      handed.set('shared', 'a,b\n97,=A2/3\n');
      const page = await browser.newPage();
      await page.goto(`${origin}/public/shared`);
      const sheet = page.frames().at(-1) as Frame;
      await expect.poll(() => sheet.locator('td[data-at="1,1"]').textContent()).toBe('32.33333333');
      // Nothing to write in, nothing to add, and no rows beyond what holds something.
      expect(await sheet.locator('tbody tr').count()).toBe(2);
      expect(await sheet.locator('[data-add]').count()).toBe(0);
      expect(await sheet.locator('[aria-label="Cell"]').getAttribute('readonly')).not.toBeNull();
      await page.close();
    });
  },
);
