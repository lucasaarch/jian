import { GatewayError } from '../core/errors.js';

/** The part of a pseudo-terminal the gateway uses; `@lydell/node-pty`'s own fits it. */
export type PtyProcess = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Without a signal, a hangup. Windows takes no signal at all. */
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
};

export type PtyOptions = {
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type SpawnPty = (file: string, args: string[], options: PtyOptions) => Promise<PtyProcess>;

type PtyModule = typeof import('@lydell/node-pty');

let loading: Promise<PtyModule> | undefined;

/**
 * Native code, with one prebuilt binary per platform and CPU, so it is loaded when the first
 * terminal opens and not with the gateway: an installation whose binary is missing or does not
 * load still starts, and only its terminals say so.
 */
export function ptyModule(): Promise<PtyModule> {
  loading ??= import('@lydell/node-pty').then(
    // The package is CommonJS: its exports arrive whole as the default.
    (loaded) => (loaded as { default?: PtyModule }).default ?? loaded,
  );

  return loading;
}

export const spawnPty: SpawnPty = async (file, args, options) => {
  let pty: PtyModule;

  try {
    pty = await ptyModule();
  } catch (error) {
    throw new GatewayError(
      501,
      `Terminals are not available on this gateway: its terminal library did not load (${
        error instanceof Error ? error.message.split('\n')[0] : 'unknown error'
      }).`,
    );
  }

  return pty.spawn(file, args, { name: 'xterm-256color', ...options });
};
