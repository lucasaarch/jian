/**
 * Builds the update files a release serves from the ones each Publish runner wrote:
 * `node scripts/update-metadata.ts <dir>` turns every `<dir>/<name>.<arch>.part` into `<dir>/<name>`.
 *
 * One OS's two CPUs are packaged on two runners, and each writes latest-mac.yml (or latest.yml)
 * listing its own files only. electron-updater reads one such file per OS and downloads the
 * entry whose name carries its arch, so the two lists become one. A file missing a CPU it should
 * list is withheld rather than published half: on that OS installed apps keep their release,
 * where they would otherwise move to the other CPU's build.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The CPUs each update file must list before it is published. */
const EXPECTED: Record<string, string[]> = {
  'latest-mac.yml': ['arm64', 'x64'],
  'latest.yml': ['arm64', 'x64'],
  'latest-linux.yml': ['x64'],
  'latest-linux-arm64.yml': ['arm64'],
};

const PART = /^(latest[\w-]*\.yml)\.(\w+)\.part$/;

export type Part = { arch: string; text: string };

/** The `files:` entries of an update file: its indented lines after `files:`. */
function filesOf(lines: string[]): { start: number; end: number } {
  const start = lines.indexOf('files:');
  if (start < 0) throw new Error('An update file has no files: list.');
  let end = start + 1;
  while (end < lines.length && /^(\s|- )/.test(lines[end] ?? '')) end += 1;
  return { start, end };
}

const versionOf = (text: string) => /^version: (.+)$/m.exec(text)?.[1]?.trim();

/**
 * One update file listing every part's files. The first part, x64 when there is one, keeps its
 * top-level `path` and `sha512`, which only electron-updater releases older than any Jian read.
 */
export function mergeParts(parts: Part[]): string {
  const ordered = [...parts].sort((a, b) =>
    a.arch === 'x64' ? -1 : b.arch === 'x64' ? 1 : a.arch.localeCompare(b.arch),
  );
  const [first, ...rest] = ordered;
  if (!first) throw new Error('No update files to merge.');
  const version = versionOf(first.text);
  const lines = first.text.split('\n');
  const { start, end } = filesOf(lines);
  const entries = lines.slice(start + 1, end);
  for (const part of rest) {
    if (versionOf(part.text) !== version) {
      throw new Error(`The ${part.arch} update file is for another version than ${version}.`);
    }
    const other = part.text.split('\n');
    const block = filesOf(other);
    entries.push(...other.slice(block.start + 1, block.end));
  }
  return [...lines.slice(0, start + 1), ...entries, ...lines.slice(end)].join('\n');
}

/** Merges a directory's parts in place; answers which update files were withheld, and why. */
export function mergeDirectory(dir: string): { written: string[]; withheld: string[] } {
  const groups = new Map<string, Part[]>();
  for (const file of readdirSync(dir)) {
    const match = PART.exec(file);
    if (!match?.[1] || !match[2]) continue;
    const parts = groups.get(match[1]) ?? [];
    parts.push({ arch: match[2], text: readFileSync(join(dir, file), 'utf8') });
    groups.set(match[1], parts);
    rmSync(join(dir, file));
  }
  const written: string[] = [];
  const withheld = Object.keys(EXPECTED)
    .filter((name) => !groups.has(name))
    .map((name) => `${name} (no build)`);
  for (const [name, parts] of groups) {
    const missing = (EXPECTED[name] ?? []).filter((arch) => !parts.some((p) => p.arch === arch));
    if (missing.length > 0) {
      withheld.push(`${name} (no ${missing.join(', ')} build)`);
      continue;
    }
    writeFileSync(join(dir, name), mergeParts(parts));
    written.push(name);
  }
  return { written, withheld };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node scripts/update-metadata.ts <dir>');
  const { written, withheld } = mergeDirectory(dir);
  for (const name of written) console.log(`Wrote ${name}`);
  // A GitHub annotation, so a release that cannot update some installs says so on its run.
  for (const name of withheld) {
    console.log(`::warning::Withheld ${name}: installed apps on it are not offered this release.`);
  }
}
