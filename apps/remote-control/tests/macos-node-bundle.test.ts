import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  collectNodeRuntimeLibraries,
  discoverSiblingNodeLibraries,
  isMacSystemLibrary,
  parseOtoolDependencies,
  parseOtoolRpaths,
  resolveMachODependency,
  rewriteBundledMachOLinks,
} from '../src/mach-o.ts';
import { macosAppBundlePaths, materializeMacosAppRuntime } from '../src/macos-app.ts';

describe('macos node runtime bundling', () => {
  const temps: string[] = [];

  after(async () => {
    await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test('isMacSystemLibrary keeps host dyld paths out of the app', () => {
    assert.equal(isMacSystemLibrary('/usr/lib/libSystem.B.dylib'), true);
    assert.equal(isMacSystemLibrary('/System/Library/Frameworks/CoreFoundation.framework/…'), true);
    assert.equal(isMacSystemLibrary('@rpath/libnode.147.dylib'), false);
    assert.equal(isMacSystemLibrary('/opt/homebrew/opt/node/lib/libnode.147.dylib'), false);
  });

  test('parseOtoolDependencies reads load commands from otool -L', () => {
    const stdout = `/opt/homebrew/Cellar/node/24.0.0/bin/node:
\t@rpath/libnode.147.dylib (compatibility version 147.0.0, current version 147.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
\t/opt/homebrew/opt/icu4c@77/lib/libicui18n.77.dylib (compatibility version 77.0.0, current version 77.1.0)
`;
    assert.deepEqual(parseOtoolDependencies(stdout), [
      '@rpath/libnode.147.dylib',
      '/usr/lib/libSystem.B.dylib',
      '/opt/homebrew/opt/icu4c@77/lib/libicui18n.77.dylib',
    ]);
  });

  test('parseOtoolRpaths reads LC_RPATH entries', () => {
    const stdout = `
Load command 18
          cmd LC_RPATH
      cmdsize 32
         path @executable_path/../lib (offset 12)
Load command 19
          cmd LC_RPATH
      cmdsize 32
         path @executable_path (offset 12)
`;
    assert.deepEqual(parseOtoolRpaths(stdout), ['@executable_path/../lib', '@executable_path']);
  });

  test('resolveMachODependency expands @rpath against LC_RPATH and sibling layouts', () => {
    const files = new Set([
      '/opt/homebrew/Cellar/node/24.0.0/lib/libnode.147.dylib',
      '/opt/homebrew/Cellar/node/24.0.0/bin/node',
    ]);
    const exists = (path: string) => files.has(path);
    assert.equal(
      resolveMachODependency('@rpath/libnode.147.dylib', {
        binaryPath: '/opt/homebrew/Cellar/node/24.0.0/bin/node',
        executablePath: '/opt/homebrew/Cellar/node/24.0.0/bin/node',
        rpaths: ['@executable_path/../lib'],
        exists,
      }),
      '/opt/homebrew/Cellar/node/24.0.0/lib/libnode.147.dylib',
    );
    assert.equal(
      resolveMachODependency('@rpath/libnode.147.dylib', {
        binaryPath: '/opt/homebrew/Cellar/node/24.0.0/bin/node',
        executablePath: '/opt/homebrew/Cellar/node/24.0.0/bin/node',
        rpaths: [],
        exists,
      }),
      '/opt/homebrew/Cellar/node/24.0.0/lib/libnode.147.dylib',
    );
  });

  test('discoverSiblingNodeLibraries finds Cellar ../lib/libnode', () => {
    const root = '/opt/homebrew/Cellar/node/24.0.0';
    const files = new Set([`${root}/bin/node`, `${root}/lib/libnode.147.dylib`]);
    const listing: Record<string, string[] | undefined> = {
      [`${root}/bin`]: ['node'],
      [`${root}/lib`]: ['libnode.147.dylib', 'README'],
      [`${root}/bin/lib`]: undefined,
    };
    const found = discoverSiblingNodeLibraries(`${root}/bin/node`, {
      exists: (path) => files.has(path) || path in listing,
      listDir: (path) => listing[path] || [],
    });
    assert.deepEqual(found, [`${root}/lib/libnode.147.dylib`]);
  });

  test('collectNodeRuntimeLibraries walks @rpath libnode and absolute ICU', () => {
    const root = '/opt/homebrew/Cellar/node/24.0.0';
    const icu = '/opt/homebrew/opt/icu4c@77/lib/libicui18n.77.dylib';
    const libnode = `${root}/lib/libnode.147.dylib`;
    const nodeBin = `${root}/bin/node`;
    const files = new Set([nodeBin, libnode, icu]);
    const deps: Record<string, string[]> = {
      [nodeBin]: ['@rpath/libnode.147.dylib', '/usr/lib/libSystem.B.dylib'],
      [libnode]: [icu, '/usr/lib/libSystem.B.dylib'],
      [icu]: ['/usr/lib/libSystem.B.dylib'],
    };
    const rpaths: Record<string, string[]> = {
      [nodeBin]: ['@executable_path/../lib'],
      [libnode]: [],
      [icu]: [],
    };
    const collected = collectNodeRuntimeLibraries(nodeBin, {
      exists: (path) => files.has(path),
      readDeps: (path) => deps[path] || [],
      readRpaths: (path) => rpaths[path] || [],
      listDir: () => [],
    });
    assert.deepEqual(collected, [libnode, icu]);
  });

  test('rewriteBundledMachOLinks changes absolute ICU to @rpath and sets ids', () => {
    const calls: string[][] = [];
    const libDir = '/tmp/Jian Remote.app/Contents/lib';
    const executablePath = '/tmp/Jian Remote.app/Contents/MacOS/Jian Remote';
    const deps: Record<string, string[]> = {
      [executablePath]: ['@rpath/libnode.147.dylib'],
      [`${libDir}/libnode.147.dylib`]: [
        '/opt/homebrew/opt/icu4c@77/lib/libicui18n.77.dylib',
        '@rpath/libnode.147.dylib',
      ],
      [`${libDir}/libicui18n.77.dylib`]: [],
    };
    rewriteBundledMachOLinks({
      executablePath,
      libDir,
      libraryBasenames: ['libnode.147.dylib', 'libicui18n.77.dylib'],
      readDeps: (path) => deps[path] || [],
      run: (cmd, argv) => {
        calls.push([cmd, ...argv]);
        return { status: 0, stdout: '' };
      },
    });
    assert.ok(
      calls.some(
        (c) =>
          c[0] === 'install_name_tool' &&
          c[1] === '-add_rpath' &&
          c[2] === '@executable_path/../lib',
      ),
    );
    assert.ok(
      calls.some(
        (c) =>
          c[0] === 'install_name_tool' &&
          c[1] === '-id' &&
          c[2] === '@rpath/libnode.147.dylib' &&
          c[3] === `${libDir}/libnode.147.dylib`,
      ),
    );
    assert.ok(
      calls.some(
        (c) =>
          c[0] === 'install_name_tool' &&
          c[1] === '-change' &&
          c[2] === '/opt/homebrew/opt/icu4c@77/lib/libicui18n.77.dylib' &&
          c[3] === '@rpath/libicui18n.77.dylib' &&
          c[4] === `${libDir}/libnode.147.dylib`,
      ),
    );
  });

  test('materializeMacosAppRuntime copies node + libnode into Contents/lib', async () => {
    const home = await mkdtemp(join(tmpdir(), 'jian-app-home-'));
    temps.push(home);
    const fakeNodeRoot = await mkdtemp(join(tmpdir(), 'jian-fake-node-'));
    temps.push(fakeNodeRoot);
    const binDir = join(fakeNodeRoot, 'bin');
    const libDir = join(fakeNodeRoot, 'lib');
    await mkdir(binDir, { recursive: true });
    await mkdir(libDir, { recursive: true });
    const nodePath = join(binDir, 'node');
    const libnodePath = join(libDir, 'libnode.147.dylib');
    await writeFile(nodePath, 'FAKE_NODE_BINARY\n', { mode: 0o755 });
    await writeFile(libnodePath, 'FAKE_LIBNODE\n', { mode: 0o755 });

    const paths = await materializeMacosAppRuntime({
      sourceNode: nodePath,
      home,
      collectLibraries: () => [libnodePath],
    });

    assert.equal(paths.libDir, macosAppBundlePaths(home).libDir);
    assert.equal(await readFile(paths.executable, 'utf8'), 'FAKE_NODE_BINARY\n');
    assert.equal(await readFile(join(paths.libDir, 'libnode.147.dylib'), 'utf8'), 'FAKE_LIBNODE\n');
    assert.deepEqual(paths.bundledLibraries, ['libnode.147.dylib']);
  });

  test('materializeMacosAppRuntime refreshes lib dir and drops stale dylibs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'jian-app-home-'));
    temps.push(home);
    const fakeNodeRoot = await mkdtemp(join(tmpdir(), 'jian-fake-node-'));
    temps.push(fakeNodeRoot);
    const nodePath = join(fakeNodeRoot, 'node');
    const libNew = join(fakeNodeRoot, 'libnode.148.dylib');
    await writeFile(nodePath, 'NODE\n', { mode: 0o755 });
    await writeFile(libNew, 'NEW\n', { mode: 0o755 });

    const first = await materializeMacosAppRuntime({
      sourceNode: nodePath,
      home,
      collectLibraries: () => [libNew],
    });
    // Simulate a previous major left behind.
    await writeFile(join(first.libDir, 'libnode.147.dylib'), 'OLD\n', { mode: 0o755 });

    const second = await materializeMacosAppRuntime({
      sourceNode: nodePath,
      home,
      collectLibraries: () => [libNew],
    });
    const names = second.bundledLibraries;
    assert.deepEqual(names, ['libnode.148.dylib']);
    await assert.rejects(() => readFile(join(second.libDir, 'libnode.147.dylib')));
    assert.equal(await readFile(join(second.libDir, 'libnode.148.dylib'), 'utf8'), 'NEW\n');
  });
});
