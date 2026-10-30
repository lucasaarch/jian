import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * The local gateway the packaged app runs, in .gateway/, which after-pack copies into the app's
 * resources: the gateway bundled into one file with everything it uses, beside the two
 * dependencies a bundle cannot hold — sharp is native code, PGlite loads its WebAssembly from its
 * own files — installed for this machine. Each platform and CPU is packaged on one of its own.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const gateway = join(root, 'apps', 'gateway');
const target = fileURLToPath(new URL('../.gateway/', import.meta.url));
/** Kept out of the bundle and installed beside it. */
const native = ['sharp', '@electric-sql/pglite'];
/** Kept out and not installed: only a server's store and queue import them. */
const unreached = ['pg', 'pg-boss'];

rmSync(target, { recursive: true, force: true });
execFileSync('pnpm', ['--filter', '@jian/contracts', 'build'], { cwd: root, stdio: 'inherit' });

// One level under dist, as the compiled modules are: the gateway finds its migrations at
// ../../migrations and its release notes at ../release-notes from there.
await build({
  entryPoints: [join(gateway, 'src', 'local.ts')],
  outfile: join(target, 'dist', 'bundle', 'local.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: [...native, ...unreached],
  // Dependencies written as CommonJS still call require; an ES module has to make one.
  banner: {
    js: "import { createRequire as jianRequire } from 'node:module'; const require = jianRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'warning',
});
cpSync(join(gateway, 'migrations'), join(target, 'migrations'), { recursive: true });
cpSync(join(root, 'docs', 'releases'), join(target, 'dist', 'release-notes'), { recursive: true });

// The versions the repository runs and tests with, installed for this platform and CPU.
const version = (name) =>
  JSON.parse(readFileSync(join(gateway, 'node_modules', name, 'package.json'), 'utf8')).version;
const dependencies = Object.fromEntries(native.map((name) => [name, version(name)]));
mkdirSync(target, { recursive: true });
writeFileSync(
  join(target, 'package.json'),
  `${JSON.stringify({ name: 'jian-local-gateway', private: true, type: 'module', dependencies }, null, 2)}\n`,
);
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], {
  cwd: target,
  stdio: 'inherit',
});
