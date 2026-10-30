import { fileURLToPath } from 'node:url';

/**
 * Where the native helpers are: `macos/`, `linux/`, `windows/` and `assets/` under one root.
 * Beside this package in a checkout; a host that moves them — the CLI's bundle, the native
 * app's resources — says where before the first screen is touched.
 */
let root = fileURLToPath(new URL('../../helpers/', import.meta.url));

export const helpersRoot = (): string => root;

export function useHelpersRoot(path: string): void {
  root = path;
}
