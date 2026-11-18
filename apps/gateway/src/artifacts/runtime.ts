import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The libraries an Artifact's frame runs, at the versions the lockfile pins: each is one file
 * that needs nothing else, sent inside the frame, so a frame asks the network for nothing.
 *
 * This module imports only Node's own, and has no syntax Node cannot strip: the build scripts
 * import it as it is to copy the files beside the compiled gateway.
 */
const FILES = {
  react: ['react', 'cjs/react.production.js'],
  scheduler: ['scheduler', 'cjs/scheduler.production.js'],
  'react-dom': ['react-dom', 'cjs/react-dom.production.js'],
  'react-dom-client': ['react-dom', 'cjs/react-dom-client.production.js'],
  marked: ['marked', 'lib/marked.umd.js'],
  mermaid: ['mermaid', 'dist/mermaid.min.js'],
} as const;

export type RuntimeFile = keyof typeof FILES;

/** Where the build copies them: beside the compiled modules, and beside a desktop's bundle. */
const STAGED = new URL('../artifact-runtime/', import.meta.url);

/**
 * The file in the installed package, for a gateway run from source and for the build. A
 * package's `exports` hides these paths, so its folder is found through its manifest.
 */
function installed(name: RuntimeFile): string {
  const [packageName, file] = FILES[name];
  const own = createRequire(import.meta.url);
  // Only react-dom depends on the scheduler, so only from there is it found.
  const from =
    packageName === 'scheduler' ? createRequire(own.resolve('react-dom/package.json')) : own;

  return join(dirname(from.resolve(`${packageName}/package.json`)), file);
}

export function runtimeSource(name: RuntimeFile): string {
  const staged = fileURLToPath(new URL(`${name}.js`, STAGED));

  return readFileSync(existsSync(staged) ? staged : installed(name), 'utf8');
}

/** Copies every file into `folder`, which is what a built gateway reads them from. */
export function stageRuntime(folder: string): void {
  mkdirSync(folder, { recursive: true });

  for (const name of Object.keys(FILES) as RuntimeFile[]) {
    copyFileSync(installed(name), join(folder, `${name}.js`));
  }
}
