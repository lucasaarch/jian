import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stamped, versionFromTag } from '../scripts/release-version.ts';
import { mergeDirectory, mergeParts } from '../scripts/update-metadata.ts';
import { compatible, releaseLine } from '../src/main/gateways/rules';
import { fromSource } from '../src/main/updates/flow';

describe('the version a release tag gives the app', () => {
  it('is the tag without its v, a candidate included', () => {
    expect(versionFromTag('v1.2.3')).toBe('1.2.3');
    expect(versionFromTag('v1.2.0-rc.1')).toBe('1.2.0-rc.1');
  });

  it('refuses what `make release` would never tag', () => {
    for (const tag of ['1.2.3', 'v1.2', 'refs/tags/v1.2.3', 'main', '', 'v1.2.3.4']) {
      expect(() => versionFromTag(tag)).toThrow(/Not a release tag/);
    }
  });

  it('replaces the development version in the manifest, and nothing else', () => {
    const manifest = `${JSON.stringify({ name: '@jian/desktop', version: '0.0.0-dev', private: true }, null, 2)}\n`;
    const result = JSON.parse(stamped(manifest, versionFromTag('v1.2.3')));
    expect(result).toEqual({ name: '@jian/desktop', version: '1.2.3', private: true });
  });

  it('makes an app that follows releases, and works with gateways of its line', () => {
    const version = versionFromTag('v1.2.3');
    expect(fromSource(true, version)).toBe(false);
    expect(releaseLine(version)).toBe('1.2');
    expect(compatible(version, '1.2.0')).toBe(true);
    expect(compatible(version, '1.1.9')).toBe(false);
  });

  it('leaves the repository’s own version a build from source, which never updates', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(fromSource(true, manifest.version)).toBe(true);
  });
});

/** An update file as electron-builder writes one, for one CPU. */
const updateFile = (version: string, arch: string, ext = 'zip') =>
  [
    `version: ${version}`,
    'files:',
    `  - url: Jian-${version}-mac-${arch}.${ext}`,
    `    sha512: ${arch}zip==`,
    '    size: 120',
    `  - url: Jian-${version}-mac-${arch}.dmg`,
    `    sha512: ${arch}dmg==`,
    '    size: 130',
    `path: Jian-${version}-mac-${arch}.${ext}`,
    `sha512: ${arch}zip==`,
    "releaseDate: '2026-10-30T12:00:00.000Z'",
    'releaseNotes: |-',
    '  Agents can share a conversation.',
    '',
  ].join('\n');

describe('the update files of a release', () => {
  it('list both CPUs of an OS, x64 first', () => {
    const merged = mergeParts([
      { arch: 'arm64', text: updateFile('1.2.3', 'arm64') },
      { arch: 'x64', text: updateFile('1.2.3', 'x64') },
    ]);
    const urls = [...merged.matchAll(/- url: (\S+)/g)].map((match) => match[1]);
    expect(urls).toEqual([
      'Jian-1.2.3-mac-x64.zip',
      'Jian-1.2.3-mac-x64.dmg',
      'Jian-1.2.3-mac-arm64.zip',
      'Jian-1.2.3-mac-arm64.dmg',
    ]);
    expect(merged).toContain('path: Jian-1.2.3-mac-x64.zip');
    expect(merged).toContain('  Agents can share a conversation.');
    expect(merged.match(/^version:/gm)).toHaveLength(1);
  });

  it('refuse to merge two versions', () => {
    expect(() =>
      mergeParts([
        { arch: 'x64', text: updateFile('1.2.3', 'x64') },
        { arch: 'arm64', text: updateFile('1.2.4', 'arm64') },
      ]),
    ).toThrow(/another version/);
  });

  describe('in a directory', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('are written from every runner’s parts, and withheld when a CPU is missing', () => {
      dir = mkdtempSync(join(tmpdir(), 'jian-update-files-'));
      writeFileSync(join(dir, 'latest-mac.yml.arm64.part'), updateFile('1.2.3', 'arm64'));
      writeFileSync(join(dir, 'latest-mac.yml.x64.part'), updateFile('1.2.3', 'x64'));
      writeFileSync(join(dir, 'latest.yml.x64.part'), updateFile('1.2.3', 'x64', 'exe'));
      writeFileSync(join(dir, 'latest-linux.yml.x64.part'), updateFile('1.2.3', 'x64', 'AppImage'));
      writeFileSync(join(dir, 'Jian-1.2.3-mac-x64.zip'), '');

      const { written, withheld } = mergeDirectory(dir);

      expect(written.sort()).toEqual(['latest-linux.yml', 'latest-mac.yml']);
      expect(withheld.sort()).toEqual([
        'latest-linux-arm64.yml (no build)',
        'latest.yml (no arm64 build)',
      ]);
      // Windows on arm64 would otherwise be offered the x64 installer.
      expect(readdirSync(dir).sort()).toEqual([
        'Jian-1.2.3-mac-x64.zip',
        'latest-linux.yml',
        'latest-mac.yml',
      ]);
    });
  });
});
