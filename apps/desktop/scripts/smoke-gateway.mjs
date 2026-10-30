/**
 * Starts the local gateway a packaged app carries, the way the app does — its own Electron as
 * Node, the bundle from its resources, a data folder of its own — and waits for it to answer.
 * `node scripts/smoke-gateway.mjs release` after packaging; it fails with everything the gateway
 * said when it does not listen within two minutes. A gateway that cannot start leaves the app
 * loading for ever on that system, which is found here instead of by an owner.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WAIT_MS = 120_000;
const release = resolve(process.argv[2] ?? 'release');

/** The packaged app in `release`: its executable, and the gateway in its resources. */
function packaged() {
  for (const name of readdirSync(release)) {
    const dir = join(release, name);
    const mac = join(dir, 'Jian.app');
    if (existsSync(mac)) {
      return {
        executable: join(mac, 'Contents', 'MacOS', 'Jian'),
        resources: join(mac, 'Contents', 'Resources'),
      };
    }
    if (!name.endsWith('-unpacked')) continue;
    const executable = ['Jian.exe', 'jian'].map((file) => join(dir, file)).find(existsSync);
    if (executable) return { executable, resources: join(dir, 'resources') };
  }
  throw new Error(`No packaged app in ${release}.`);
}

const { executable, resources } = packaged();
const root = join(resources, 'gateway');
const entry = join(root, 'dist', 'bundle', 'local.mjs');
const data = mkdtempSync(join(tmpdir(), 'jian-smoke-'));
const port = 40_000 + Math.floor(Math.random() * 20_000);
console.log(`Starting ${entry}\n  with ${executable}\n  in ${data}, on ${port}`);

const child = spawn(executable, [entry], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    JIAN_LOCAL_DIR: data,
    JIAN_API_TOKEN: randomBytes(24).toString('hex'),
    JIAN_MASTER_KEY: randomBytes(32).toString('base64'),
    PORT: String(port),
    JIAN_PUBLIC_URL: `http://127.0.0.1:${port}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let said = '';
let verdict;
/** Says how it went once, then lets the gateway end before its folder is cleared. */
const finish = (code, message) => {
  if (verdict) return;
  verdict = { code, message };
  if (child.exitCode === null) child.kill();
  else done();
};
const done = () => {
  try {
    rmSync(data, { recursive: true, force: true });
  } catch {
    // The runner clears its own temporary files.
  }
  const { code, message } = verdict;
  if (code) console.error(`${message}\n--- what the gateway said ---\n${said || '(nothing)'}`);
  else console.log(message);
  process.exit(code);
};

const timer = setTimeout(
  () => finish(1, `The gateway did not listen within ${WAIT_MS / 1000}s.`),
  WAIT_MS,
);
child.stderr.on('data', (chunk) => {
  said += chunk;
});
child.stdout.on('data', async (chunk) => {
  said += chunk;
  for (const line of String(chunk).split('\n')) {
    let listening;
    try {
      listening = JSON.parse(line).listening;
    } catch {
      continue;
    }
    if (typeof listening !== 'string') continue;
    clearTimeout(timer);
    try {
      const health = await fetch(`${listening}/health`);
      finish(health.ok ? 0 : 1, `The gateway listens at ${listening}: /health ${health.status}.`);
    } catch (error) {
      finish(1, `The gateway said it listens at ${listening}, but /health failed: ${error}`);
    }
  }
});
child.on('exit', (code) => {
  clearTimeout(timer);
  finish(1, `The gateway ended with code ${code} before it listened.`);
  done();
});
