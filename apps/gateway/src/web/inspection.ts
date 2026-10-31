import { packInspection, snapshotDocument } from '@jian/browser-core';
import { pageInspectionInputSchema } from '@jian/contracts';
import type { z } from 'zod';
import { withPage } from './browser.js';

export const pageInspectionSchema = pageInspectionInputSchema;

/** An inspection is a replayable read, not an authenticated browser session or a code executor. */
export async function inspectPage(
  input: z.infer<typeof pageInspectionSchema>,
  fetcher: typeof fetch,
  signal: AbortSignal,
) {
  if (input.reusePage)
    throw new Error(
      'Only the Jian desktop browser can inspect an already open page; server inspections must use reusePage false',
    );
  return withPage(
    input.url,
    fetcher,
    signal,
    { width: input.width, height: input.height },
    async (page, resources, blocked) => {
      for (const action of input.actions) {
        const frame = page.frames()[action.frame];
        if (!frame)
          throw new Error(`Frame ${action.frame} is no longer available; inspect the page again`);
        if (action.type === 'scroll') {
          await frame.evaluate(({ x, y }) => window.scrollTo(x, y), action);
        } else {
          const element = frame.locator(action.selector);
          if (action.type === 'click') await element.click({ timeout: 3000 });
          else await element.fill(action.text, { timeout: 3000 });
        }
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        signal.throwIfAborted();
      }
      await page.evaluate(async () => {
        await Promise.race([
          document.fonts.ready,
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      });
      const frames = [];
      for (const [index, frame] of page.frames().entries()) {
        if (index >= 30) break;
        const snapshot = await frame.evaluate(snapshotDocument).catch(() => null);
        if (snapshot) frames.push({ index, url: frame.url(), ...snapshot });
      }
      if (!frames.length) throw new Error('The page has no readable document');
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 85, timeout: 5000 });
      const { archive, snapshot } = packInspection({
        url: page.url(),
        title: await page.title(),
        viewport: { width: input.width, height: input.height },
        actions: input.actions,
        frames,
        resources,
        blocked,
        framesTruncated: page.frames().length > 30,
      });
      return { screenshot, archive, snapshot };
    },
  );
}
