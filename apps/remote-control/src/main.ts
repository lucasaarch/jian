import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { args, parseCliInvocation } from './args.ts';
import { configure, install, reinstall } from './install.ts';
import { logs } from './logs.ts';
import { ANSI, paint, shouldColorize } from './output.ts';
import { run } from './run.ts';
import { cliRestart, cliStart, cliStop } from './service.ts';
import { status } from './status.ts';
import { update } from './update.ts';
import { PACKAGE_VERSION } from './version.ts';

/**
 * True when this file is the process entry. npm’s `.bin/jian-remote` is a symlink; comparing
 * resolve() paths alone misses that and made `npx … install` exit 0 with no stdout/stderr.
 */
export function isCliEntry(argv1 = process.argv[1], metaUrl = import.meta.url): boolean {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return resolve(fileURLToPath(metaUrl)) === resolve(argv1);
  }
}

/** Runs the command argv names; an error prints as one line and exits 1. */
export async function main(): Promise<void> {
  try {
    const invocation = parseCliInvocation(args);
    if (invocation.command === 'version') console.log(PACKAGE_VERSION);
    else if (invocation.command === 'install') await install();
    else if (invocation.command === 'configure') await configure();
    else if (invocation.command === 'update') await update();
    else if (invocation.command === 'reinstall') await reinstall();
    else if (invocation.command === 'stop') await cliStop();
    else if (invocation.command === 'start') await cliStart();
    else if (invocation.command === 'restart') await cliRestart();
    else if (invocation.command === 'run') await run();
    else if (invocation.command === 'status') await status();
    else if (invocation.command === 'logs') await logs();
    else {
      const color = shouldColorize();
      const title = paint('Jian Remote', ANSI.bold, color);
      const pkg = paint('(@jian-ai/remote-control)', ANSI.dim, color);
      console.log(`${title} worker ${pkg}
  install [--system] --gateway HTTPS_URL --machine UUID --token VALUE
  status [--json]
  logs [--lines N] [--level debug|info|warn|error] [--follow]
  update [--version X.Y.Z|latest]
  reinstall [--no-restart]
  stop | start | restart
  version

Install:  run the command the panel shows when you add a machine or rotate its
          credentials: npm install -g @jian-ai/remote-control, then jian-remote install.
          Running it again replaces the credentials and restarts the worker.
          (Linux headless/root VPS: add --system, or use a normal user + loginctl enable-linger)
Status:   jian-remote status   (connection, machine, versions, ping, actions run)
Logs:     jian-remote logs --follow
Update:   jian-remote update   (installs the gateway's release with npm and restarts on it;
          the panel and agents can ask the worker for the same)`);
    }
  } catch (error) {
    const color = shouldColorize({ isTTY: process.stderr.isTTY });
    const prefix = paint('Error', ANSI.red, color);
    console.error(`${prefix}: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
