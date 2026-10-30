import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The local gateway the packaged app runs: the gateway compiled, with its production
 * dependencies, in .gateway/, which electron-builder copies into the app's resources. Native
 * dependencies (sharp) are the ones of the machine this runs on, so each platform and CPU is
 * packaged on a machine of its own.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const target = fileURLToPath(new URL('../.gateway/', import.meta.url));
// CI: deploy installs into a fresh directory and must never stop to ask about the one it fills.
const pnpm = (args) =>
  execFileSync('pnpm', args, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } });

rmSync(target, { recursive: true, force: true });
pnpm(['--filter', '@jian/gateway', 'build']);
pnpm(['--filter', '@jian/gateway', '--prod', 'deploy', '--legacy', target]);
// A production deploy records the workspace as installed without its dev dependencies, and the
// next pnpm command would reinstall in production mode; this puts the workspace's state back.
pnpm(['install', '--frozen-lockfile', '--prefer-offline']);
