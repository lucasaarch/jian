import { withPage } from './browser.js';

export function isClaudeArtifact(url: string): boolean {
  const address = new URL(url);
  return (
    address.protocol === 'https:' &&
    ((address.hostname === 'claude.ai' &&
      /^\/(?:public\/|code\/)?artifacts?\/[^/]+\/?$/.test(address.pathname)) ||
      (address.hostname === 'claude.site' && /^\/artifacts\/[^/]+\/?$/.test(address.pathname)))
  );
}

const UNAVAILABLE =
  'The Claude artifact content did not load. It may require sign-in, access approval, or a browser challenge, which a server cannot complete. Inspect it with inspect_page in the Jian desktop app, where the owner can complete them; use Computer Use on a connected machine; or ask the owner to attach an export of the artifact.';

export async function readClaudeArtifact(url: string, fetcher: typeof fetch, signal: AbortSignal) {
  try {
    return await withPage(url, fetcher, signal, { width: 1440, height: 900 }, async (page) => {
      const parts: string[] = [];
      for (const frame of page.frames()) {
        const host = new URL(frame.url() || 'about:blank').hostname;
        if (!host.endsWith('.claudeusercontent.com') && host !== 'claudeusercontent.com') continue;
        const text = await frame
          .locator('body')
          .innerText({ timeout: 1000 })
          .catch(() => '');
        if (text.trim()) parts.push(text.trim());
      }
      if (!parts.length) throw new Error('The viewer rendered no content frame');
      return { url: page.url(), title: await page.title(), text: parts.join('\n\n') };
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`${UNAVAILABLE} Cause: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}
