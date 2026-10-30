import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ensureHelperBinary, helperPaths, packagedHelper } from '../src/computer/windows.ts';

describe('the Windows helper where it runs', () => {
  const temps: string[] = [];
  after(() => Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))));

  it('installs the binary built for this CPU, and the next release over it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jian-win-helper-'));
    temps.push(root);
    await mkdir(join(root, 'windows'));
    await writeFile(join(root, 'windows', 'computer-helper-x64.exe'), 'x64 build');
    await writeFile(join(root, 'windows', 'computer-helper-arm64.exe'), 'arm64 build');
    const paths = helperPaths(join(root, 'home'));

    const installed = await ensureHelperBinary({ packaged: packagedHelper(root, 'arm64'), paths });
    assert.equal(installed, paths.binary);
    assert.equal(await readFile(installed, 'utf8'), 'arm64 build');

    await writeFile(join(root, 'windows', 'computer-helper-arm64.exe'), 'arm64 next release');
    await ensureHelperBinary({ packaged: packagedHelper(root, 'arm64'), paths });
    assert.equal(await readFile(installed, 'utf8'), 'arm64 next release');
  });
});
