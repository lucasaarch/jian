import { join } from 'node:path';
import { app, Notification, type UtilityProcess, utilityProcess } from 'electron';
import { stablePort } from './address';
import type { LocalCredentials } from './credentials';

/** How long a crashed gateway waits before it is started again, growing to a minute. */
const RETRY_MS = [1_000, 5_000, 15_000, 60_000];

type Listener = (url: string | undefined) => void;

/**
 * The gateway this computer runs for its owner, in a Node process of the app's own: started
 * with the app, started again if it ends, stopped when the app quits, on the same port every
 * time; `listener` hears when it listens and when it ended.
 */
export class LocalGateway {
  private child?: UtilityProcess;
  private failures = 0;
  private stopping = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly credentials: LocalCredentials,
    private readonly listener: Listener,
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    const { port, moved } = await stablePort();
    if (moved) announceMove();
    const { entry, cwd, execArgv } = launch();
    const child = utilityProcess.fork(entry, [], {
      cwd,
      execArgv,
      serviceName: 'Jian gateway',
      stdio: 'pipe',
      env: {
        ...process.env,
        JIAN_LOCAL_DIR: join(app.getPath('userData'), 'gateway'),
        JIAN_API_TOKEN: this.credentials.token,
        JIAN_MASTER_KEY: this.credentials.masterKey,
        PORT: String(port),
        // Where the owner's browser comes back to after a GitHub or MCP sign-in.
        JIAN_PUBLIC_URL: `http://127.0.0.1:${port}`,
        JIAN_VERSION: app.isPackaged ? app.getVersion() : '',
      },
    });
    this.child = child;

    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const url = listening(line);
        if (url) {
          this.failures = 0;
          this.listener(url);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.listener(undefined);
      if (this.stopping) return;
      const wait = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)] ?? 60_000;
      this.failures += 1;
      this.timer = setTimeout(() => void this.start(), wait);
    });
  }

  /** Lets the gateway finish what it is writing; it is killed if it has not ended in time. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const forced = setTimeout(() => {
        child.kill();
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(forced);
        resolve();
      });
      child.postMessage({ stop: true });
    });
  }
}

/**
 * Something else took the port GitHub and MCP servers know the gateway by, so they would send
 * the owner back to the wrong place: the owner connects them again.
 */
function announceMove(): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'Jian moved its local gateway',
    body: 'Another app took its address. Connect GitHub and MCP sign-ins again in Settings.',
  }).show();
}

/** The address in the gateway's one line of its own on stdout, among Fastify's log lines. */
function listening(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { listening?: unknown };
    return typeof parsed.listening === 'string' ? parsed.listening : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Packaged, the gateway is one bundled file with its two native dependencies in the app's
 * resources (scripts/stage-gateway.mjs). From
 * source, it is the repository's TypeScript, which tsx compiles as it loads (see the script).
 */
function launch(): { entry: string; cwd: string; execArgv: string[] } {
  if (app.isPackaged) {
    const root = join(process.resourcesPath, 'gateway');
    return { entry: join(root, 'dist', 'bundle', 'local.mjs'), cwd: root, execArgv: [] };
  }
  const root = join(import.meta.dirname, '../../../gateway');
  return { entry: join(root, 'scripts', 'local-from-source.mjs'), cwd: root, execArgv: [] };
}
