import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs the app from source, `dev` with hot reload or `start` from the last build. On macOS the
 * menu bar and the Dock name an app by its bundle, which from source is Electron's own; a copy
 * of that bundle named Jian, made once per Electron version, makes the app read as itself.
 */
const [command = 'start', ...rest] = process.argv.slice(2);
const here = fileURLToPath(new URL('..', import.meta.url));
// The package's own binaries, as `pnpm run` would find them, when this runs on its own.
const bin = join(here, 'node_modules', '.bin');
const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };

if (process.platform === 'darwin') {
  const dist = renamedElectron();
  // `electron .` reads the folder; electron-vite reads only the binary's own path.
  env.ELECTRON_OVERRIDE_DIST_PATH = dist;
  env.ELECTRON_EXEC_PATH = join(dist, electronBinary());
}

const [program, args] =
  command === 'dev' ? ['electron-vite', ['dev', ...rest]] : ['electron', ['.', ...rest]];
const child = spawn(program, args, {
  cwd: here,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 0));

/** Where Electron keeps its binary inside its folder, as its own package writes it down. */
function electronBinary() {
  const electron = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
  return readFileSync(join(electron, 'path.txt'), 'utf8');
}

function renamedElectron() {
  const electron = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
  const { version } = JSON.parse(readFileSync(join(electron, 'package.json'), 'utf8'));
  const target = join(here, '.dev', 'electron');
  const stamp = join(target, 'version');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) return target;

  rmSync(target, { recursive: true, force: true });
  // ditto keeps the bundle's symlinks and extended attributes, which cp would not.
  execFileSync('ditto', [join(electron, 'dist'), target]);
  const app = join(target, 'Electron.app');
  const plist = join(app, 'Contents', 'Info.plist');
  for (const [key, value] of [
    ['CFBundleName', 'Jian'],
    ['CFBundleDisplayName', 'Jian'],
    // Its own identity, apart from the packaged app's, so the two never share permissions.
    ['CFBundleIdentifier', 'com.jian.desktop.dev'],
  ]) {
    execFileSync('plutil', ['-replace', key, '-string', value, plist]);
  }
  // Editing the plist breaks Electron's signature; Apple silicon runs nothing unsigned.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
  writeFileSync(stamp, version);
  return target;
}
