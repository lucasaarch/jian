import { chmod, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { helpersRoot } from '@jian/remote-core';
import { build } from 'esbuild';
import { validateWorkerScriptBytes } from '../src/worker-script.ts';

/**
 * The published worker: one file, `dist/jian-remote.mjs`, with the Computer Use helpers beside
 * it. One file because the gateway serves it whole for self-update, and the service runs the
 * copy install puts in ~/.config/jian-remote.
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
  legalComments: 'none',
  logLevel: 'warning',
});

// Every installed worker finds the version by this exact line, in what it downloads and in
// what it runs, and refuses an update without it; the bundler writes `var … = "…"`.
const source = await readFile(bundle, 'utf8');
const marker = /^var PACKAGE_VERSION = "[^"]*";$/m;
if (!marker.test(source)) throw new Error('The bundle lost its PACKAGE_VERSION line.');
const stamped = source.replace(marker, `export const PACKAGE_VERSION = '${version}';`);
const checked = validateWorkerScriptBytes(stamped);
if (!checked.ok) throw new Error(`The bundle would be refused as an update: ${checked.message}`);
await writeFile(bundle, stamped);
await chmod(bundle, 0o755);

// The helpers' build script and sources ship as they are; the prebuilt macOS binary, when a
// release built one into the helpers, ships with them.
await cp(helpersRoot(), dist.pathname, { recursive: true });
