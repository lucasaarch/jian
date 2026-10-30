import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * How a Node binary links its libraries, read with otool and rewritten with install_name_tool:
 * what Jian Remote.app copies beside its own Node so it starts without the original install.
 */

type Exists = (path: string) => boolean;
type ListDir = (path: string) => string[];
type ReadPaths = (binaryPath: string) => string[];
type Run = (command: string, argv: string[]) => unknown;

/** dyld system locations — leave these on the host; do not copy into the app. */
export function isMacSystemLibrary(depPath: string): boolean {
  if (!depPath) return true;
  if (depPath.startsWith('/usr/lib/')) return true;
  if (depPath.startsWith('/System/')) return true;
  if (depPath.startsWith('/Library/Apple/')) return true;
  if (depPath.startsWith('/usr/local/lib/libSystem')) return true;
  return false;
}

/**
 * Parse `otool -L` lines into load-command paths (skips the header "path:" line).
 * Example line: `\t@rpath/libnode.147.dylib (compatibility version 147.0.0, current version …)`
 */
export function parseOtoolDependencies(stdout: string): string[] {
  const deps: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.endsWith(':')) continue;
    const match = /^(.+?)\s+\(compatibility version\b/.exec(trimmed);
    const dep = match?.[1]?.trim();
    if (dep) deps.push(dep);
  }
  return deps;
}

/**
 * Parse LC_RPATH entries from `otool -l` (or `otool -l -v`) output.
 * Looks for: `cmd LC_RPATH` … `path <value> (offset …)`
 */
export function parseOtoolRpaths(stdout: string): string[] {
  const rpaths: string[] = [];
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/\bLC_RPATH\b/.test(lines[i] ?? '')) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      const path = /^\s*path\s+(.+?)(?:\s+\(offset\s+\d+\))?\s*$/.exec(lines[j] ?? '')?.[1];
      if (path) {
        rpaths.push(path.trim());
        break;
      }
    }
  }
  return rpaths;
}

/**
 * Expand @executable_path / @loader_path / @rpath against the source Node layout.
 * Absolute paths pass through. Unresolvable @rpath names return null.
 */
export function resolveMachODependency(
  dep: string,
  {
    binaryPath,
    executablePath,
    rpaths = [],
    exists = existsSync,
  }: { binaryPath: string; executablePath?: string; rpaths?: string[]; exists?: Exists },
): string | null {
  if (!dep) return null;
  const loaderDir = dirname(binaryPath);
  const execDir = dirname(executablePath || binaryPath);

  const expandPrefix = (value: string) => {
    if (value.startsWith('@loader_path')) {
      return join(loaderDir, value.slice('@loader_path'.length).replace(/^\//, '') || '.');
    }
    if (value.startsWith('@executable_path')) {
      return join(execDir, value.slice('@executable_path'.length).replace(/^\//, '') || '.');
    }
    return value;
  };

  if (dep.startsWith('@rpath/')) {
    const rest = dep.slice('@rpath/'.length);
    for (const rpath of rpaths) {
      const base = expandPrefix(rpath);
      const candidate = join(base, rest);
      if (exists(candidate)) return candidate;
    }
    // Common Node layouts when LC_RPATH is missing from a stub parse: bin/ + ../lib/.
    for (const candidate of [
      join(loaderDir, rest),
      join(loaderDir, '..', 'lib', rest),
      join(execDir, rest),
      join(execDir, '..', 'lib', rest),
    ]) {
      if (exists(candidate)) return candidate;
    }
    return null;
  }

  if (dep.startsWith('@loader_path') || dep.startsWith('@executable_path')) {
    const candidate = expandPrefix(dep);
    return exists(candidate) ? candidate : null;
  }

  if (dep.startsWith('/')) {
    return exists(dep) ? dep : null;
  }

  return null;
}

const SIBLING_DYLIB_PREFIXES = [
  'libnode.',
  'libuv.',
  'libbrotli',
  'libcares.',
  'libnghttp',
  'libopenssl.',
  'libssl.',
  'libcrypto.',
  'libicu',
];

/**
 * Sibling search when otool is unavailable or incomplete — Homebrew Cellar and
 * official tarballs keep libnode next to bin/ or under ../lib/.
 */
export function discoverSiblingNodeLibraries(
  nodePath: string,
  { exists = existsSync, listDir }: { exists?: Exists; listDir?: ListDir } = {},
): string[] {
  const dir = dirname(nodePath);
  const searchDirs = [dir, join(dir, 'lib'), join(dir, '..', 'lib')];
  const found: string[] = [];
  const list =
    listDir ||
    ((path: string) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    });
  for (const searchDir of searchDirs) {
    if (!exists(searchDir)) continue;
    for (const name of list(searchDir)) {
      if (!name.endsWith('.dylib')) continue;
      if (!SIBLING_DYLIB_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      const full = join(searchDir, name);
      if (exists(full)) found.push(full);
    }
  }
  return found;
}

/**
 * BFS: every non-system Mach-O dependency of `nodePath` that must live inside the .app.
 * Returns absolute source paths (deduped, stable order).
 */
export function collectNodeRuntimeLibraries(
  nodePath: string,
  {
    exists = existsSync,
    readDeps = defaultReadOtoolDeps,
    readRpaths = defaultReadOtoolRpaths,
    listDir,
  }: {
    exists?: Exists;
    readDeps?: ReadPaths;
    readRpaths?: ReadPaths;
    listDir?: ListDir;
  } = {},
): string[] {
  const realNode = (() => {
    try {
      return realpathSync(nodePath);
    } catch {
      return nodePath;
    }
  })();

  const queue = [realNode];
  const seenBinaries = new Set<string>();
  const libraries: string[] = [];
  const seenLibs = new Set<string>();

  const enqueueLib = (source: string) => {
    let real = source;
    try {
      real = realpathSync(source);
    } catch {
      // keep source
    }
    if (seenLibs.has(real)) return;
    seenLibs.add(real);
    libraries.push(real);
    queue.push(real);
  };

  // Seed Cellar/tarball siblings first so a missing otool still walks transitive deps.
  for (const sibling of discoverSiblingNodeLibraries(realNode, { exists, listDir })) {
    enqueueLib(sibling);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seenBinaries.has(current)) continue;
    seenBinaries.add(current);

    const rpaths = readRpaths(current);
    const deps = readDeps(current);
    for (const dep of deps) {
      if (isMacSystemLibrary(dep)) continue;
      // Self-id lines sometimes appear as the dylib's install name — skip when it resolves to self.
      const resolved = resolveMachODependency(dep, {
        binaryPath: current,
        executablePath: realNode,
        rpaths,
        exists,
      });
      if (!resolved) continue;
      let realResolved = resolved;
      try {
        realResolved = realpathSync(resolved);
      } catch {
        // keep
      }
      if (realResolved === realNode || realResolved === current) continue;
      if (isMacSystemLibrary(realResolved)) continue;
      enqueueLib(realResolved);
    }
  }

  return libraries;
}

function defaultReadOtoolDeps(binaryPath: string): string[] {
  const result = spawnSync('otool', ['-L', binaryPath], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return parseOtoolDependencies(result.stdout || '');
}

function defaultReadOtoolRpaths(binaryPath: string): string[] {
  const result = spawnSync('otool', ['-l', binaryPath], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return parseOtoolRpaths(result.stdout || '');
}

/** Drop Gatekeeper quarantine on a path (best-effort; missing xattr is fine). */
export function clearMacQuarantine(targetPath: string): void {
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', targetPath], { encoding: 'utf8' });
}

function runInstallNameTool(argv: string[], run: Run): void {
  // -add_rpath fails (status 1) when the rpath already exists — that is fine.
  run('install_name_tool', argv);
}

/**
 * Rewrite load commands so bundled libs resolve via `@rpath/<basename>` inside Contents/lib.
 * Best-effort: missing install_name_tool still leaves copies under Contents/lib for @rpath.
 */
export function rewriteBundledMachOLinks({
  executablePath,
  libDir,
  libraryBasenames,
  readDeps = defaultReadOtoolDeps,
  run = (cmd, argv) => spawnSync(cmd, argv, { encoding: 'utf8' }),
}: {
  executablePath: string;
  libDir: string;
  libraryBasenames: string[];
  readDeps?: ReadPaths;
  run?: Run;
}): void {
  const names = new Set(libraryBasenames);

  runInstallNameTool(['-add_rpath', '@executable_path/../lib', executablePath], run);
  runInstallNameTool(['-add_rpath', '@executable_path', executablePath], run);

  for (const name of names) {
    runInstallNameTool(['-id', `@rpath/${name}`, join(libDir, name)], run);
  }

  const consumers = [executablePath, ...[...names].map((name) => join(libDir, name))];
  for (const consumer of consumers) {
    for (const dep of readDeps(consumer)) {
      if (isMacSystemLibrary(dep)) continue;
      const depBase = basename(
        dep
          .replace(/^@rpath\//, '')
          .replace(/^@loader_path\//, '')
          .replace(/^@executable_path\//, ''),
      );
      if (!names.has(depBase)) continue;
      const desired = `@rpath/${depBase}`;
      if (dep === desired) continue;
      runInstallNameTool(['-change', dep, desired, consumer], run);
    }
  }
}
