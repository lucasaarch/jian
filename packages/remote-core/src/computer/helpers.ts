import { fileURLToPath } from 'node:url';

/**
 * Where the built helpers are: `macos/`, `linux/` and `windows/` under one root. In a checkout,
 * native/bin, where the build scripts write; a host that moves them — the CLI's bundle, the
 * native app's resources — says where before the first screen is touched.
 */
let root = fileURLToPath(new URL('../../native/bin/', import.meta.url));

export const helpersRoot = (): string => root;

export function useHelpersRoot(path: string): void {
  root = path;
}
