import { fileURLToPath } from 'node:url';

/**
 * Where the built helpers are: `macos/`, `linux/` and `windows/` under one root. In a checkout,
 * native/bin, where the build scripts write; a host that moves them — the CLI's bundle, the
 * native app's resources — says where before the first screen is touched.
 */
let root = fileURLToPath(new URL('../../native/bin/', import.meta.url));

export const helpersRoot = (): string => root;

export function setHelpersRoot(path: string): void {
  root = path;
}

/**
 * Where a helper is copied to run from, outside the package so an update replaces it in one
 * place. Each system has the CLI's own place by default; a host beside it, the native app, says
 * its own, so the two never overwrite each other's copy.
 */
let installDir: string | undefined;

export const helpersInstallDir = (): string | undefined => installDir;

export function setHelpersInstallDir(path: string): void {
  installDir = path;
}
