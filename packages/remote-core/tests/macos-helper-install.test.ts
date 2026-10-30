import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ensureHelperBinary, helperPaths } from '../src/computer/macos/helper.ts';

describe('the macOS helper where it runs', () => {
  const temps: string[] = [];
  after(() => Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))));

  /** A home of its own, and a package whose helper holds `bytes` (none when undefined). */
  async function setup(bytes?: string) {
    const root = await mkdtemp(join(tmpdir(), 'jian-mac-helper-'));
    temps.push(root);
    const packaged = join(root, 'computer-helper');
    if (bytes !== undefined) await writeFile(packaged, bytes);
    return { packaged, paths: helperPaths(join(root, 'home')) };
  }

  it('installs the packaged helper, and replaces it when an update ships other bytes', async () => {
    const { packaged, paths } = await setup('release one');
    const installed = await ensureHelperBinary({ packaged, paths });
    assert.equal(await readFile(installed, 'utf8'), 'release one');

    await writeFile(packaged, 'release two');
    await ensureHelperBinary({ packaged, paths });
    assert.equal(await readFile(installed, 'utf8'), 'release two');
  });

  it('keeps running the installed helper when the package lost its copy', async () => {
    const { packaged, paths } = await setup('installed before');
    await ensureHelperBinary({ packaged, paths });
    await rm(packaged);
    assert.equal(
      await readFile(await ensureHelperBinary({ packaged, paths }), 'utf8'),
      'installed before',
    );
  });

  it('says the helper is missing when there is none anywhere', async () => {
    const { packaged, paths } = await setup();
    await assert.rejects(ensureHelperBinary({ packaged, paths }), /helper is missing/);
  });
});
