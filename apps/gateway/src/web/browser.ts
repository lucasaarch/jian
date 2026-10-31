import { tmpdir } from 'node:os';
import type { Page } from 'playwright';

const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_REQUESTS = 200;

/**
 * A page inspection runs JavaScript in a temporary browser. Give each read an empty browser context;
 * every resource goes through the same DNS-pinned outbound guard as ordinary page reads.
 * The browser never gets cookies, credentials or a direct network fallback.
 *
 * Chromium's own sandbox needs user namespaces, which a container refuses. The image's
 * JIAN_BROWSER_PATH runs it under Landlock instead, as an agent's commands run, so a page that broke
 * out of the renderer still reaches no secret of the gateway. Elsewhere its own sandbox stays on.
 */
export type PageResource = { url: string; mimeType: string; data: Buffer };
export type BlockedResource = { url: string; reason: string };

export async function withPage<T>(
  url: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  viewport: { width: number; height: number },
  inspect: (page: Page, resources: PageResource[], blocked: BlockedResource[]) => Promise<T>,
): Promise<T> {
  const { chromium } = await import('playwright');
  signal.throwIfAborted();
  const confined = process.env.JIAN_BROWSER_PATH;
  const executable = confined || process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const browser = await chromium
    .launch({
      chromiumSandbox: !confined,
      ...(executable ? { executablePath: executable } : {}),
      args: [
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        // A container's /dev/shm is 64 MB, too little for a page of any size.
        ...(confined ? ['--disable-dev-shm-usage'] : []),
      ],
      // By name, never inherited: the gateway's environment holds its keys.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: confined ? tmpdir() : (process.env.HOME ?? tmpdir()),
        TMPDIR: tmpdir(),
      },
      timeout: 10_000,
    })
    .catch((error: unknown) => {
      throw new Error(
        `The browser could not start on this gateway: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`,
      );
    });
  const close = () => {
    void browser.close().catch(() => {});
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      viewport,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    const resources: PageResource[] = [];
    const blocked: BlockedResource[] = [];
    let requests = 0;
    let bytes = 0;
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (
        signal.aborted ||
        requests >= MAX_REQUESTS ||
        bytes >= MAX_TOTAL_BYTES ||
        !['GET', 'HEAD'].includes(request.method()) ||
        request.resourceType() === 'media'
      ) {
        blocked.push({
          url: request.url(),
          reason: 'Request method, resource type or page limit is not allowed',
        });
        await route.abort().catch(() => {});
        return;
      }
      try {
        // Keep the public viewer's protocol headers, but never browser credentials.
        const headers = Object.fromEntries(
          Object.entries(request.headers()).filter(
            ([name]) =>
              ['accept', 'accept-language', 'user-agent', 'origin', 'referer'].includes(name) ||
              name.startsWith('x-frame-'),
          ),
        );
        // Playwright does not route a redirected request again. Resolve every hop here;
        // fulfilling a 3xx would let Chromium follow it outside the outbound guard.
        let address = request.url();
        let response: Response;
        for (let hop = 0; ; hop += 1) {
          if (++requests > MAX_REQUESTS) throw new Error('Too many page requests');
          response = await fetcher(address, {
            method: request.method(),
            redirect: 'manual',
            headers,
            signal,
          });
          const location = response.headers.get('location');
          if (response.status < 300 || response.status >= 400 || !location) break;
          await response.body?.cancel().catch(() => {});
          if (hop >= 5) throw new Error('Too many page redirects');
          address = new URL(location, address).toString();
        }
        if (!response.ok || response.headers.get('cf-mitigated') === 'challenge') {
          await response.body?.cancel().catch(() => {});
          throw new Error(
            `The page resource answered ${response.status}${response.headers.get('cf-mitigated') === 'challenge' ? ' (browser challenge)' : ''}`,
          );
        }
        if (address !== request.url() && request.isNavigationRequest()) {
          await response.body?.cancel().catch(() => {});
          // Start a new navigation rather than a browser-followed redirect: it is routed again,
          // while location/origin and relative fetches keep the final document's semantics.
          const destination = JSON.stringify(address).replaceAll('<', '\\u003c');
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<script>location.replace(${destination})</script>`,
          });
          return;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              bytes += next.value.byteLength;
              if (size > MAX_RESOURCE_BYTES || bytes > MAX_TOTAL_BYTES)
                throw new Error('Page too large');
              chunks.push(next.value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        }
        const responseHeaders = Object.fromEntries(response.headers);
        // Fetch decoded the payload; fulfillment must not decompress or count it again.
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];
        delete responseHeaders['set-cookie'];
        let body = Buffer.concat(chunks);
        resources.push({
          url: address,
          mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
          data: body,
        });
        if (address !== request.url() && /html/i.test(responseHeaders['content-type'] ?? '')) {
          // Relative assets in a redirected document belong to the final address.
          const base = address
            .replaceAll('&', '&amp;')
            .replaceAll('"', '&quot;')
            .replaceAll('<', '&lt;');
          body = Buffer.from(`<base href="${base}">${body.toString('utf8')}`);
        }
        await route.fulfill({ status: response.status, headers: responseHeaders, body });
      } catch (error) {
        blocked.push({
          url: request.url(),
          reason: error instanceof Error ? error.message : 'Page resource failed',
        });
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch {
      signal.throwIfAborted();
      throw new Error(
        blocked.find((resource) => resource.url === url)?.reason ?? 'The page could not be opened',
      );
    }
    // Network idle covers client rendering and frame navigation, bounded by the read deadline.
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    signal.throwIfAborted();
    return await inspect(page, resources, blocked);
  } finally {
    signal.removeEventListener('abort', close);
    await browser.close();
  }
}
