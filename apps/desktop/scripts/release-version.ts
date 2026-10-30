/**
 * Stamps the app with the version its release tag names: `node scripts/release-version.ts v1.2.3`.
 * The packaged app reports it as its own (`app.getVersion()`), electron-builder names the files
 * and the update files with it, and electron-updater compares releases by it. The repository
 * keeps 0.0.0-dev, which the app reads as a build from source that never updates.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The tags `make release` pushes: scripts/release.mjs accepts the same versions. */
const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function versionFromTag(tag: string): string {
  const version = TAG.exec(tag.trim())?.[1];
  if (!version) throw new Error(`Not a release tag: "${tag}". Expected v1.2.3 or v1.2.3-rc.1.`);
  return version;
}

/** The package manifest with the version in place, everything else as it was. */
export function stamped(manifest: string, version: string): string {
  const parsed = JSON.parse(manifest) as Record<string, unknown>;
  return `${JSON.stringify({ ...parsed, version }, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = versionFromTag(process.argv[2] ?? '');
  const file = fileURLToPath(new URL('../package.json', import.meta.url));
  writeFileSync(file, stamped(readFileSync(file, 'utf8'), version));
  console.log(`@jian/desktop is ${version}`);
}
