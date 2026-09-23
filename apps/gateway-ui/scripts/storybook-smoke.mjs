// Opens every story of the built Storybook in headless Chromium and fails when one throws,
// logs an error or renders nothing. A story nobody opens rots quietly; this is what notices.
//
//   pnpm storybook:smoke    builds storybook-static, then runs this against it
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../storybook-static/', import.meta.url));

if (!existsSync(join(root, 'index.json'))) {
  console.error('No storybook-static/index.json: run pnpm storybook:build first.');
  process.exit(1);
}

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname));
  const file = join(root, path === '/' ? 'index.html' : path);

  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404).end();

    return;
  }

  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
const origin = `http://127.0.0.1:${port}`;
const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
const stories = Object.values(index.entries).filter((entry) => entry.type === 'story');

// What a story may log without being broken: React's development notices, and the network a
// story deliberately fails to show an error state.
const noise = [/Download the React DevTools/, /Failed to load resource/, /\[MSW\]/];

const browser = await chromium.launch();
const failures = [];

try {
  for (const story of stories) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const problems = [];

    page.on('pageerror', (error) => problems.push(`threw: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !noise.some((pattern) => pattern.test(message.text()))) {
        problems.push(`logged: ${message.text().slice(0, 300)}`);
      }
    });

    await page.goto(`${origin}/iframe.html?id=${story.id}&viewMode=story`);

    try {
      await page.waitForFunction(
        () => {
          const root = document.querySelector('#storybook-root');

          return Boolean(root?.children.length) || Boolean(document.querySelector('dialog[open]'));
        },
        undefined,
        { timeout: 15_000 },
      );
      // Pages load their data after the first paint; give that a moment to fail if it will.
      await page.waitForTimeout(800);
    } catch {
      problems.push('rendered nothing within 15 s');
    }

    // A page still on the session check never received its data.
    if (await page.locator('main.boot').count()) {
      problems.push('stuck on the session check: the workspace never loaded');
    }

    const errorShown = await page
      .locator('.sb-errordisplay:visible, #error-message:visible')
      .count()
      .catch(() => 0);

    if (errorShown) {
      problems.push(
        `Storybook error: ${(await page.locator('#error-message').innerText()).slice(0, 300)}`,
      );
    }

    console.log(`${problems.length ? '✗' : '✓'} ${story.title} › ${story.name}`);

    if (problems.length) {
      failures.push({ story: `${story.title} › ${story.name}`, problems });
    }

    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} of ${stories.length} stories are broken:`);

  for (const failure of failures) {
    console.error(`\n${failure.story}\n  ${failure.problems.join('\n  ')}`);
  }

  process.exit(1);
}

console.log(`\nAll ${stories.length} stories render.`);
