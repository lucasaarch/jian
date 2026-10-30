import { chmod, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { helpersRoot } from '@jian/remote-core';
import { build } from 'esbuild';

/**
 * The published worker: one file, `dist/jian-remote.mjs`, with the Computer Use helpers beside
 * it, which install copies to ~/.config/jian-remote for the service to run.
 */
const dist = new URL('../dist/', import.meta.url);
const bundle = new URL('jian-remote.mjs', dist);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await rm(dist, { recursive: true, force: true });
await build({
  entryPoints: [new URL('../src/bin.ts', import.meta.url).pathname],
  outfile: bundle.pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: { js: '#!/usr/bin/env node' },
  // Workers up to 1.0.5 still update themselves once, from npm, to their gateway's release, and
  // take a script only with the version line, `updateIfNeeded` and `async function run(` in it.
  footer: { js: '// Accepted as an update by Jian Remote 1.0.5 and earlier (updateIfNeeded).' },
  legalComments: 'none',
  logLevel: 'warning',
});

// `status` and `update` read a worker's release from this exact line, and so do the workers
// above; the bundler writes `var … = "…"`.
const source = await readFile(bundle, 'utf8');
const marker = /^var PACKAGE_VERSION = "[^"]*";$/m;
if (!marker.test(source)) throw new Error('The bundle lost its PACKAGE_VERSION line.');
const stamped = source.replace(marker, `export const PACKAGE_VERSION = '${version}';`);
const legacy = ["export const PACKAGE_VERSION = '", 'updateIfNeeded', 'async function run('];
if (stamped.length > 1_000_000 || legacy.some((needle) => !stamped.includes(needle))) {
  throw new Error('Workers of 1.0.5 and earlier would refuse this bundle as their update.');
}
await writeFile(bundle, stamped);
await chmod(bundle, 0o755);

// The helpers' build script and sources ship as they are; the prebuilt macOS binary, when a
// release built one into the helpers, ships with them.
await cp(helpersRoot(), dist.pathname, { recursive: true });
