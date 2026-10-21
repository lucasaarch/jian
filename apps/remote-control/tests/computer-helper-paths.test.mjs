import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { packageHelperPaths } from '../bin/computer-macos.mjs';

describe('computer-helper package paths', () => {
  const temps = [];

  after(async () => {
    await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('resolves swift source and binary under macos/', () => {
    const paths = packageHelperPaths('/pkg/remote-control');
    assert.equal(paths.swift, '/pkg/remote-control/macos/computer-helper.swift');
    assert.equal(paths.binary, '/pkg/remote-control/macos/computer-helper');
  });

  it('default package root is the apps/remote-control directory beside bin/', async () => {
    const paths = packageHelperPaths();
    assert.match(paths.swift, /apps\/remote-control\/macos\/computer-helper\.swift$/);
    // Source is always in the tree; binary is Publish-only and may be absent in git checkouts.
    const { access } = await import('node:fs/promises');
    await access(paths.swift);
  });

  it('can stage a fake packaged binary layout for materialize smoke', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jian-helper-pkg-'));
    temps.push(root);
    const macos = join(root, 'macos');
    await mkdir(macos, { recursive: true });
    await writeFile(join(macos, 'computer-helper.swift'), '// fake\n', { mode: 0o644 });
    await writeFile(join(macos, 'computer-helper'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    await chmod(join(macos, 'computer-helper'), 0o755);
    const paths = packageHelperPaths(root);
    assert.equal(paths.swift, join(macos, 'computer-helper.swift'));
    assert.equal(paths.binary, join(macos, 'computer-helper'));
  });
});
