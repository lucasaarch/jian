// Real image smoke: page inspection as the gateway runs it, from its deployed tree, in a container
// with no capabilities. It fails, rather than skips, when the browser cannot start confined.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { pageInspectionInputSchema } from '@jian/contracts';
import { inspectPage } from './dist/web/inspection.js';

const SECRET = 'synthetic-gateway-secret-do-not-leak';
process.env.JIAN_MASTER_KEYS = SECRET;

const server = createServer((request, response) => {
  const stylesheet = request.url.endsWith('.css');
  response.setHeader('content-type', stylesheet ? 'text/css' : 'text/html');
  response.end(
    stylesheet
      ? 'h1 { color: rgb(1, 2, 3) }'
      : '<title>Atlas</title><link rel=stylesheet href=/a.css><h1>Atlas preview</h1><button id=menu onclick="details.hidden=false">Menu</button><div id=details hidden>Expanded details</div>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

// While the browser runs: what the gateway keeps in its environment is not in Chromium's.
const environments = [];
const watcher = setInterval(() => {
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes('chromium'))
        environments.push(readFileSync(`/proc/${pid}/environ`, 'latin1'));
    } catch {
      // It ended between the listing and the read.
    }
  }
}, 100);

const inspected = await inspectPage(
  pageInspectionInputSchema.parse({
    url,
    width: 800,
    height: 600,
    actions: [{ type: 'click', selector: '#menu' }],
  }),
  fetch,
  AbortSignal.timeout(45_000),
);
clearInterval(watcher);

const frame = inspected.snapshot.frames[0];
assert.equal(inspected.snapshot.title, 'Atlas');
assert.ok(frame.text.includes('Expanded details'), 'Interactions replay in the real browser');
assert.equal(frame.elements.find((element) => element.tag === 'h1').styles.color, 'rgb(1, 2, 3)');
assert.ok(inspected.screenshot.length > 1000, 'The page is rendered');
assert.ok(inspected.archive.byteLength > 100, 'The export is packed');
assert.ok(
  inspected.snapshot.resources.some((resource) => resource.url.endsWith('/a.css')),
  'Loaded resources are exported',
);
assert.ok(environments.length > 0, 'The browser process was seen');
assert.ok(
  environments.every((environment) => !environment.includes(SECRET)),
  'The browser does not inherit the gateway secrets',
);

// The confinement itself: the browser cannot read the gateway's own files.
const { stdout } = await promisify(execFile)(
  process.env.JIAN_BROWSER_PATH,
  ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', 'file:///app/package.json'],
  { env: { PATH: process.env.PATH, HOME: '/tmp' }, timeout: 30_000 },
).catch((error) => ({ stdout: error.stdout ?? '' }));
assert.ok(!stdout.includes('@jian/gateway'), 'The browser cannot read the gateway files');

server.close();
console.log('Page inspection in the image: rendered, interactive, exported and confined.');
