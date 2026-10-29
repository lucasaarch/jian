#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const configDir = join(homedir(), '.config', 'jian-remote');
const configPath = join(configDir, 'config.json');
/** Stable path the OS service runs — not the npx cache or a transient install location. */
const installedScript = join(configDir, 'jian-remote.mjs');
/** Exclusive run lock — prevents KeepAlive / CLI races from leaving two pollers alive. */
const workerLockPath = join(configDir, 'worker.pid');
const updateStatePath = join(configDir, 'update-state.json');
const MACOS_LAUNCH_AGENT_LABEL = 'com.jian.remote';
const LINUX_SERVICE_UNIT = 'jian-remote.service';
/** Remembers whether Linux install used systemd --user or a system unit (headless/root VPS). */
const linuxServiceScopePath = join(configDir, 'linux-service-scope');
const LINUX_SYSTEM_UNIT_PATH = join('/etc/systemd/system', LINUX_SERVICE_UNIT);
const WINDOWS_TASK_NAME = 'Jian Remote';
/** Minimal PATH for launchd — app-identity Node copies otherwise inherit an empty env. */
export const LAUNCH_AGENT_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
/** KeepAlive floor so a bad update cannot spin-restart every second. */
export const LAUNCH_AGENT_THROTTLE_INTERVAL_SEC = 10;

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

/**
 * Parse argv for the top-level command and version flags (`version`, `--version`, `-V`).
 * Version flags win over a subcommand so `jian-remote --version update` still prints the version.
 */
export function parseCliInvocation(argv = args) {
  const list = Array.isArray(argv) ? argv : [];
  if (list.includes('--version') || list.includes('-V') || list[0] === 'version') {
    return { command: 'version', versionRequested: true };
  }
  const command = list[0] && !list[0].startsWith('-') ? list[0] : undefined;
  return { command, versionRequested: false };
}

/**
 * Stamped to the release tag on npm publish and when the gateway serves this script.
 * Compatibility with the gateway requires the same major.minor (see versionsCompatible).
 */
export const PACKAGE_VERSION = '0.0.0-dev';

/** Soft stdout/stderr caps while capturing a command (chars). Gateway schema matches these. */
const STDOUT_CAP = 400_000;
const STDERR_CAP = 50_000;
/**
 * Max JSON body for a result POST. The gateway route allows 512 KiB; leave headroom for
 * framing so a full screenshot still fits without a 413.
 */
const RESULT_BODY_BUDGET = 480_000;
/** Permanent HTTP statuses — retrying forever leaves the task stuck and the machine offline. */
const PERMANENT_RESULT_STATUS = new Set([400, 401, 403, 404, 413]);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const MACOS_BUNDLE_ID = 'com.jian.remote';
const MACOS_APP_NAME = 'Jian Remote';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
};

/** Color when stdout is a TTY, unless NO_COLOR; FORCE_COLOR=1 enables even when piped. */
export function shouldColorize(options = {}) {
  // Use `in` so tests can pass forceColor: undefined without falling back to the process env.
  const isTTY = 'isTTY' in options ? options.isTTY : process.stdout.isTTY;
  const noColor = 'noColor' in options ? options.noColor : process.env.NO_COLOR;
  const forceColor = 'forceColor' in options ? options.forceColor : process.env.FORCE_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  if (forceColor !== undefined && forceColor !== '' && forceColor !== '0') return true;
  return Boolean(isTTY);
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

function paint(text, code, color) {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

/**
 * Tasteful success block for install/configure/update — headline plus aligned facts.
 * Keep facts short; avoid rainbow spam.
 */
export function formatSuccessBlock({ headline, facts = [], color = shouldColorize() }) {
  const mark = paint('✓', ANSI.green, color);
  const title = paint(headline, ANSI.bold, color);
  const lines = [`${mark} ${title}`];
  const width = Math.min(12, Math.max(0, ...facts.map(([label]) => String(label).length)));
  for (const [label, value] of facts) {
    const key = paint(String(label).padEnd(width), ANSI.dim, color);
    lines.push(`  ${key}  ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

function printSuccess(headline, facts) {
  process.stdout.write(formatSuccessBlock({ headline, facts, color: shouldColorize() }));
}

function printInfo(message) {
  const color = shouldColorize();
  const prefix = paint('·', ANSI.dim, color);
  console.log(`${prefix} ${message}`);
}

function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Paths for the thin macOS .app that owns Login Items / TCC identity (not system node). */
export function macosAppBundlePaths(home = homedir()) {
  const appRoot = join(
    home,
    'Library',
    'Application Support',
    MACOS_APP_NAME,
    `${MACOS_APP_NAME}.app`,
  );
  return {
    appRoot,
    contents: join(appRoot, 'Contents'),
    macosDir: join(appRoot, 'Contents', 'MacOS'),
    /** Homebrew / official Node often load `@rpath/libnode.*.dylib` from here. */
    libDir: join(appRoot, 'Contents', 'lib'),
    executable: join(appRoot, 'Contents', 'MacOS', MACOS_APP_NAME),
    infoPlist: join(appRoot, 'Contents', 'Info.plist'),
    bundleId: MACOS_BUNDLE_ID,
  };
}

/** dyld system locations — leave these on the host; do not copy into the app. */
export function isMacSystemLibrary(depPath) {
  if (typeof depPath !== 'string' || !depPath) return true;
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
export function parseOtoolDependencies(stdout) {
  const deps = [];
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.endsWith(':')) continue;
    const match = /^(.+?)\s+\(compatibility version\b/.exec(trimmed);
    if (!match) continue;
    const dep = match[1].trim();
    if (dep) deps.push(dep);
  }
  return deps;
}

/**
 * Parse LC_RPATH entries from `otool -l` (or `otool -l -v`) output.
 * Looks for: `cmd LC_RPATH` … `path <value> (offset …)`
 */
export function parseOtoolRpaths(stdout) {
  const rpaths = [];
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/\bLC_RPATH\b/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      const match = /^\s*path\s+(.+?)(?:\s+\(offset\s+\d+\))?\s*$/.exec(lines[j]);
      if (match) {
        rpaths.push(match[1].trim());
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
  dep,
  { binaryPath, executablePath, rpaths = [], exists = existsSync } = {},
) {
  if (typeof dep !== 'string' || !dep) return null;
  const loaderDir = dirname(binaryPath);
  const execDir = dirname(executablePath || binaryPath);

  const expandPrefix = (value) => {
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
export function discoverSiblingNodeLibraries(nodePath, { exists = existsSync, listDir } = {}) {
  const dir = dirname(nodePath);
  const searchDirs = [dir, join(dir, 'lib'), join(dir, '..', 'lib')];
  const found = [];
  const list =
    listDir ||
    ((path) => {
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
  nodePath,
  {
    exists = existsSync,
    readDeps = defaultReadOtoolDeps,
    readRpaths = defaultReadOtoolRpaths,
    listDir,
  } = {},
) {
  const realNode = (() => {
    try {
      return realpathSync(nodePath);
    } catch {
      return nodePath;
    }
  })();

  const queue = [realNode];
  const seenBinaries = new Set();
  const libraries = [];
  const seenLibs = new Set();

  const enqueueLib = (source) => {
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

function defaultReadOtoolDeps(binaryPath) {
  const result = spawnSync('otool', ['-L', binaryPath], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return parseOtoolDependencies(result.stdout || '');
}

function defaultReadOtoolRpaths(binaryPath) {
  const result = spawnSync('otool', ['-l', binaryPath], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return parseOtoolRpaths(result.stdout || '');
}

/** Drop Gatekeeper quarantine on a path (best-effort; missing xattr is fine). */
export function clearMacQuarantine(targetPath) {
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', targetPath], { encoding: 'utf8' });
}

function runInstallNameTool(argv, run) {
  // -add_rpath fails (status 1) when the rpath already exists — that is fine.
  return run('install_name_tool', argv);
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
}) {
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

export function buildMacosAppInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleDisplayName</key><string>${MACOS_APP_NAME}</string>
<key>CFBundleExecutable</key><string>${MACOS_APP_NAME}</string>
<key>CFBundleIdentifier</key><string>${MACOS_BUNDLE_ID}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>${MACOS_APP_NAME}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
}

export function buildLaunchAgentPlist({
  label,
  executable,
  script,
  logPath,
  pathEnv = LAUNCH_AGENT_PATH,
  throttleIntervalSec = LAUNCH_AGENT_THROTTLE_INTERVAL_SEC,
  home = homedir(),
  tmpDir = process.env.TMPDIR || '/tmp',
}) {
  // ProcessType=Interactive opts the worker out of App Nap. Without it, macOS can freeze the
  // Node poll loop while the screen is locked or idle; lastSeenAt ages out and the gateway
  // shows Offline even though the process is still "running".
  // Explicit PATH + HOME: launchd + the Jian Remote.app Node copy otherwise inherit a sparse
  // env. Missing HOME makes os.homedir() / shell cwd wrong; without /bin on PATH, child tools
  // fail. Invalid cwd surfaces as the misleading "spawn /bin/sh ENOENT" from libuv.
  // ThrottleInterval: after an update exit, KeepAlive must not immediately fight a CLI restart.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlEscape(label)}</string>
<key>AssociatedBundleIdentifiers</key>
<array><string>${MACOS_BUNDLE_ID}</string></array>
<key>ProgramArguments</key>
<array>
<string>${xmlEscape(executable)}</string>
<string>${xmlEscape(script)}</string>
<string>run</string>
</array>
<key>WorkingDirectory</key><string>${xmlEscape(home)}</string>
<key>EnvironmentVariables</key>
<dict>
<key>PATH</key><string>${xmlEscape(pathEnv)}</string>
<key>HOME</key><string>${xmlEscape(home)}</string>
<key>TMPDIR</key><string>${xmlEscape(tmpDir)}</string>
</dict>
<key>ProcessType</key><string>Interactive</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>${Number(throttleIntervalSec) || 10}</integer>
<key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
<key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict></plist>
`;
}

/**
 * Copy the current Node binary *and* its @rpath shared libs (libnode, ICU, …) into
 * Jian Remote.app, then ad-hoc sign so Login Items / TCC attach to Jian — not system node.
 * Homebrew / nvm / fnm / official pkg layouts resolve via Contents/lib (@executable_path/../lib).
 */
export async function materializeMacosAppRuntime({
  sourceNode = process.execPath,
  home = homedir(),
  collectLibraries = collectNodeRuntimeLibraries,
} = {}) {
  const paths = macosAppBundlePaths(home);
  await mkdir(paths.macosDir, { recursive: true, mode: 0o755 });
  await mkdir(paths.libDir, { recursive: true, mode: 0o755 });
  await writeFile(paths.infoPlist, buildMacosAppInfoPlist(), { mode: 0o644 });

  let realSource = sourceNode;
  try {
    realSource = realpathSync(sourceNode);
  } catch {
    // keep sourceNode
  }

  const temp = `${paths.executable}.${process.pid}.tmp`;
  await copyFile(realSource, temp);
  await chmod(temp, 0o755);
  await rename(temp, paths.executable);

  // Drop stale dylibs from a previous Node major so @rpath cannot pick an old libnode.
  try {
    for (const name of await readdir(paths.libDir)) {
      if (!name.endsWith('.dylib')) continue;
      await rm(join(paths.libDir, name), { force: true });
    }
  } catch {
    // lib dir may be brand new
  }

  const librarySources = collectLibraries(realSource);
  const libraryBasenames = [];
  for (const libSource of librarySources) {
    const name = basename(libSource);
    if (!name.endsWith('.dylib')) continue;
    const dest = join(paths.libDir, name);
    await copyFile(libSource, dest);
    await chmod(dest, 0o755);
    libraryBasenames.push(name);
  }

  if (libraryBasenames.length > 0) {
    rewriteBundledMachOLinks({
      executablePath: paths.executable,
      libDir: paths.libDir,
      libraryBasenames,
    });
  }

  clearMacQuarantine(paths.appRoot);

  // Sign nested dylibs first, then the executable, then the bundle (ad-hoc / unsigned path).
  for (const name of libraryBasenames) {
    spawnSync(
      'codesign',
      ['--force', '-s', '-', '--identifier', MACOS_BUNDLE_ID, join(paths.libDir, name)],
      { stdio: 'ignore' },
    );
  }
  spawnSync('codesign', ['--force', '-s', '-', '--identifier', MACOS_BUNDLE_ID, paths.executable], {
    stdio: 'ignore',
  });
  spawnSync('codesign', ['--force', '-s', '-', '--identifier', MACOS_BUNDLE_ID, paths.appRoot], {
    stdio: 'ignore',
  });
  return { ...paths, bundledLibraries: libraryBasenames };
}

export function parseRelease(version) {
  const raw = typeof version === 'string' ? version.replace(/^v/, '').trim() : '';
  const match = SEMVER.exec(raw);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
    raw,
  };
}

export function isDevVersion(version) {
  const raw = typeof version === 'string' ? version.replace(/^v/, '').trim() : '';
  return !raw || raw === '0.0.0-dev' || raw === '0.0.0';
}

/**
 * Rule: a released remote-control may talk to a released gateway only when major.minor match
 * (patch and prerelease may differ). A gateway with no version (local `make dev`) skips the
 * gate so developers are not blocked. A released gateway rejects a dev/unknown worker.
 */
export function versionsCompatible(localVersion, gatewayVersion) {
  if (isDevVersion(gatewayVersion)) {
    return { ok: true, skipped: true };
  }
  const gateway = parseRelease(gatewayVersion);
  if (!gateway) return { ok: true, skipped: true };

  if (isDevVersion(localVersion)) {
    return {
      ok: false,
      skipped: false,
      local: localVersion ?? 'unknown',
      gateway: gateway.raw,
      required: `${gateway.major}.${gateway.minor}`,
      message: `This remote-control build (${localVersion ?? 'unknown'}) is not a released package and cannot connect to gateway ${gateway.raw}. Install a matching release: npx @jian-ai/remote-control@${gateway.raw} update`,
    };
  }
  const local = parseRelease(localVersion);
  if (!local) {
    return {
      ok: false,
      skipped: false,
      local: localVersion ?? 'unknown',
      gateway: gateway.raw,
      required: `${gateway.major}.${gateway.minor}`,
      message: `This remote-control version (${localVersion ?? 'unknown'}) is not a valid release and cannot connect to gateway ${gateway.raw}.`,
    };
  }
  if (local.major === gateway.major && local.minor === gateway.minor) {
    return { ok: true, skipped: false, local: local.raw, gateway: gateway.raw };
  }
  return {
    ok: false,
    skipped: false,
    local: local.raw,
    gateway: gateway.raw,
    required: `${gateway.major}.${gateway.minor}`,
    message: `This remote-control ${local.raw} is incompatible with gateway ${gateway.raw}. Jian requires the same major.minor (${gateway.major}.${gateway.minor}). Connected workers try to self-update to the gateway version automatically; if that fails, run: npx @jian-ai/remote-control@${gateway.raw} update`,
  };
}

export function compatibilityError(localVersion, gatewayVersion) {
  const result = versionsCompatible(localVersion, gatewayVersion);
  return result.ok ? null : result.message;
}

/**
 * True when the worker should self-update so its PACKAGE_VERSION matches the gateway release.
 * Covers patch bumps and major.minor skew (fleet upgrade to the gateway’s version). Dev /
 * unversioned gateways never force a match.
 */
export function shouldMatchGatewayVersion(localVersion, gatewayVersion) {
  if (isDevVersion(gatewayVersion)) return false;
  const gateway = parseRelease(gatewayVersion);
  if (!gateway) return false;
  if (isDevVersion(localVersion)) return true;
  const local = parseRelease(localVersion);
  if (!local) return true;
  return local.raw !== gateway.raw;
}

/** Soft ceiling so a failed fleet update does not KeepAlive-spin every few seconds. */
export function nextUpdateBackoffMs(failureCount) {
  const n = Math.max(0, Number(failureCount) || 0);
  // 5s, 10s, … then cap at 30 minutes (2^9 * 5s = 2560s > 30m).
  return Math.min(30 * 60_000, 5_000 * 2 ** Math.min(n, 9));
}

/**
 * Reject garbage / HTML / truncated downloads before replacing ~/.config/jian-remote/jian-remote.mjs.
 * Credentials and config.json are never touched by the updater.
 */
export function validateWorkerScriptBytes(bytes) {
  if (!Buffer.isBuffer(bytes) && typeof bytes !== 'string') {
    return { ok: false, message: 'Worker update was empty or unreadable.' };
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buffer.length || buffer.length > 1_000_000) {
    return { ok: false, message: 'Invalid worker update size.' };
  }
  const source = buffer.toString('utf8');
  if (!source.includes('Jian Remote') || !/export const PACKAGE_VERSION = '[^']+'/.test(source)) {
    return { ok: false, message: 'Worker update did not look like a Jian Remote script.' };
  }
  if (!source.includes('updateIfNeeded') || !source.includes('async function run(')) {
    return { ok: false, message: 'Worker update was missing required entrypoints.' };
  }
  return { ok: true, version: readEmbeddedVersion(source) };
}

export function cappedAppend(current, chunk, cap = STDOUT_CAP) {
  return (current + chunk.toString('utf8')).slice(0, cap);
}

/** Shrink stdout/stderr until the JSON body fits under budget (UTF-8 byte length). */
export function fitResult(result, budget = RESULT_BODY_BUDGET) {
  let stdout = result.stdout ?? '';
  let stderr = result.stderr ?? '';
  const computer = result.computer;
  const pack = () =>
    JSON.stringify({
      taskId: result.taskId,
      exitCode: result.exitCode,
      stdout,
      stderr,
      timedOut: Boolean(result.timedOut),
      ...(computer ? { computer } : {}),
    });
  let body = pack();
  if (Buffer.byteLength(body) <= budget) {
    return {
      result: { ...result, stdout, stderr, timedOut: Boolean(result.timedOut), computer },
      body,
    };
  }

  const note = '\n… truncated to fit the gateway size limit';
  while (Buffer.byteLength(body) > budget && stdout.length > 0) {
    const overflow = Buffer.byteLength(body) - budget + Buffer.byteLength(note);
    const cut = Math.min(stdout.length, Math.max(2048, overflow));
    stdout = stdout.slice(0, Math.max(0, stdout.length - cut));
    body = pack();
  }
  if (stdout.length < (result.stdout?.length ?? 0))
    stdout = `${stdout}${note}`.slice(0, STDOUT_CAP);

  body = pack();
  while (Buffer.byteLength(body) > budget && stderr.length > 0) {
    const overflow = Buffer.byteLength(body) - budget + Buffer.byteLength(note);
    const cut = Math.min(stderr.length, Math.max(1024, overflow));
    stderr = stderr.slice(0, Math.max(0, stderr.length - cut));
    body = pack();
  }
  if (stderr.length < (result.stderr?.length ?? 0))
    stderr = `${stderr}${note}`.slice(0, STDERR_CAP);

  body = pack();
  if (Buffer.byteLength(body) > budget) {
    // Last resort: drop payloads so the agent unblocks instead of spinning on 413.
    stdout = '';
    stderr = 'Result omitted: payload exceeded the gateway size limit after truncation.';
    body = pack();
  }

  return {
    result: { ...result, stdout, stderr, timedOut: Boolean(result.timedOut) },
    body,
  };
}

async function readStdin() {
  let value = '';
  for await (const chunk of process.stdin) value += chunk.toString('utf8');
  return value;
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Secret prompt requires an interactive terminal; use --token-stdin instead');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return await new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') return finish(new Error('Installation cancelled'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

function runChecked(command, commandArgs, message) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(message);
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    throw new Error(
      `No Jian Remote config at ${configPath}. Run install first (from the panel), or: jian-remote install --gateway https://… --machine UUID --token …`,
    );
  }
}

const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseGatewayBase(gateway) {
  let gatewayUrl;
  try {
    gatewayUrl = new URL(gateway);
  } catch {
    return undefined;
  }
  if (
    gatewayUrl.protocol !== 'https:' ||
    gatewayUrl.username ||
    gatewayUrl.password ||
    gatewayUrl.search ||
    gatewayUrl.hash
  ) {
    return undefined;
  }
  return gatewayUrl.origin + gatewayUrl.pathname.replace(/\/$/, '');
}

async function readTokenOption() {
  const inlineToken = option('--token');
  if (inlineToken) return inlineToken;
  if (args.includes('--token-stdin')) return await readStdin();
  if (args.includes('--token-prompt')) return await readSecret('Worker token (input hidden): ');
  return undefined;
}

/** Persist credentials with owner-only permissions under ~/.config/jian-remote. */
async function writeConfigFile(config) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const account = process.env.USERNAME;
    if (!account) throw new Error('Could not identify the current Windows user');
    runChecked(
      'icacls.exe',
      [configDir, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`],
      'Could not restrict permissions on the Jian Remote config directory',
    );
  } else {
    await chmod(configDir, 0o700);
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform === 'win32') {
    runChecked(
      'icacls.exe',
      [configPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`],
      'Could not restrict permissions on the Jian Remote config file',
    );
  } else {
    await chmod(configPath, 0o600);
  }
}

/** Public /health carries the gateway release so install/update can gate without a worker token. */
export async function fetchGatewayVersion(gatewayBase, fetcher = fetch) {
  const response = await fetcher(`${gatewayBase.replace(/\/$/, '')}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Could not read gateway version: HTTP ${response.status}`);
  const body = await response.json();
  return typeof body?.version === 'string' && body.version.trim() ? body.version.trim() : undefined;
}

async function assertCompatibleWithGateway(gatewayBase, localVersion = PACKAGE_VERSION) {
  const gatewayVersion = await fetchGatewayVersion(gatewayBase);
  const error = compatibilityError(localVersion, gatewayVersion);
  if (error) throw new Error(error);
  return gatewayVersion;
}

function readEmbeddedVersion(scriptSource) {
  const match = /export const PACKAGE_VERSION = '([^']+)'/.exec(scriptSource);
  return match?.[1] ?? 'unknown';
}

/** Pull a specific npm release’s worker script into a temp path (for update when self is wrong). */
function fetchNpmWorkerScript(version) {
  const dir = mkdtempSync(join(tmpdir(), 'jian-remote-'));
  try {
    const packed = spawnSync(
      'npm',
      ['pack', `@jian-ai/remote-control@${version}`, '--pack-destination', dir],
      { encoding: 'utf8', windowsHide: true },
    );
    if (packed.status !== 0) {
      throw new Error(
        packed.stderr?.trim() ||
          `Could not download @jian-ai/remote-control@${version} from npm. Check the version and network.`,
      );
    }
    const tarball = packed.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!tarball)
      throw new Error(`npm pack produced no tarball for @jian-ai/remote-control@${version}`);
    const tarballPath = join(dir, tarball);
    const extracted = spawnSync('tar', ['-xzf', tarballPath, '-C', dir], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (extracted.status !== 0) {
      throw new Error(extracted.stderr?.trim() || 'Could not extract the remote-control package');
    }
    return readFileSync(join(dir, 'package', 'bin', 'jian-remote.mjs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copy computer-use companions next to the installed worker. Never overwrites jian-remote.mjs
 * (auto-update must not clobber a gateway-stamped script with an older npm copy).
 */
async function materializeCompanionModules() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const companions = [
      'computer.mjs',
      'computer-shared.mjs',
      'computer-macos.mjs',
      'computer-linux.mjs',
      'computer-windows.mjs',
    ];
    for (const name of companions) {
      const src = join(here, name);
      const dest = join(configDir, name);
      if (existsSync(src) && src !== dest) {
        await copyFile(src, dest);
        if (process.platform !== 'win32') await chmod(dest, 0o700);
      }
    }
    const { materializeComputerHelperSources } = await import('./computer.mjs');
    await materializeComputerHelperSources(configDir);
  } catch {
    // Install still succeeds; computer-use probe will explain if the helper is missing.
  }
}

/** Copy a worker script into ~/.config so npx and global installs share one service path. */
async function materializeWorkerScript(sourceBytes) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  if (sourceBytes) {
    const temp = `${installedScript}.${process.pid}.tmp`;
    await writeFile(temp, sourceBytes, { mode: 0o700 });
    await rename(temp, installedScript);
  } else {
    const source = fileURLToPath(import.meta.url);
    if (source !== installedScript) await copyFile(source, installedScript);
  }
  if (process.platform !== 'win32') await chmod(installedScript, 0o700);
  await materializeCompanionModules();
  return installedScript;
}

/** True when `pid` is a live process (best-effort; false on ESRCH / invalid). */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export function readWorkerLockPid(lockPath = workerLockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, Math.max(0, Number(ms) || 0));
}

/**
 * Stop a stray worker PID (SIGTERM → wait → SIGKILL). Used by stop/restart and the run lock.
 */
export function terminateWorkerPid(
  pid,
  { waitMs = 8_000, kill = process.kill.bind(process) } = {},
) {
  if (!isPidAlive(pid)) return { stopped: true, alreadyDead: true };
  try {
    kill(pid, 'SIGTERM');
  } catch {
    return { stopped: !isPidAlive(pid) };
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && isPidAlive(pid)) sleepMs(100);
  if (isPidAlive(pid)) {
    try {
      kill(pid, 'SIGKILL');
    } catch {
      // ESRCH — already gone.
    }
    sleepMs(100);
  }
  return { stopped: !isPidAlive(pid) };
}

/**
 * Claim the exclusive worker lock. If another live PID holds it, terminate that process first
 * so KeepAlive / CLI restarts never leave two pollers on the same machine.
 */
export async function acquireWorkerLock({
  lockPath = workerLockPath,
  pid = process.pid,
  maxAttempts = 8,
} = {}) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const existing = readWorkerLockPid(lockPath);
    if (existing && existing !== pid && isPidAlive(existing)) {
      console.error(
        `Another Jian Remote worker is running (pid ${existing}); stopping it before continuing.`,
      );
      terminateWorkerPid(existing);
    }
    if (existing && !isPidAlive(existing)) {
      try {
        await unlink(lockPath);
      } catch {
        // Lost the race to remove a stale lock; retry create.
      }
    }
    try {
      writeFileSync(lockPath, `${pid}\n`, { flag: 'wx', mode: 0o600 });
      return { ok: true, pid };
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      sleepMs(150);
    }
  }
  throw new Error(
    `Could not claim the Jian Remote worker lock at ${lockPath}. Stop other workers with: jian-remote stop`,
  );
}

export async function releaseWorkerLock({ lockPath = workerLockPath, pid = process.pid } = {}) {
  const existing = readWorkerLockPid(lockPath);
  if (existing !== undefined && existing !== pid) return;
  try {
    await unlink(lockPath);
  } catch {
    // Best-effort; a stale pid file is cleared on the next acquire.
  }
}

function macosPlistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${MACOS_LAUNCH_AGENT_LABEL}.plist`);
}

function linuxUserUnitPath() {
  return join(homedir(), '.config', 'systemd', 'user', LINUX_SERVICE_UNIT);
}

/**
 * True when this process can talk to the per-user systemd bus.
 * Headless VPS / root SSH sessions often lack XDG_RUNTIME_DIR and fail with
 * "Failed to connect to bus: No medium found".
 */
export function linuxUserBusAvailable({
  env = process.env,
  run = (argv) => spawnSync('systemctl', ['--user', ...argv], { encoding: 'utf8' }),
} = {}) {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (!runtimeDir || typeof runtimeDir !== 'string') return false;
  try {
    if (!statSync(runtimeDir).isDirectory()) return false;
  } catch {
    return false;
  }
  const result = run(['show-environment']);
  if (result.error) return false;
  const stderr = `${result.stderr ?? ''}`;
  if (/Failed to connect to bus|No medium found|No such file or directory/i.test(stderr)) {
    return false;
  }
  return result.status === 0;
}

/** True when this process can install `/etc/systemd/system/jian-remote.service`. */
export function canInstallLinuxSystemUnit({
  uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
  systemDir = '/etc/systemd/system',
  access = (path, mode) => accessSync(path, mode),
} = {}) {
  if (uid === 0) return true;
  try {
    access(systemDir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function linuxServiceKind(scope = 'user') {
  return scope === 'system' ? 'systemd (system)' : 'systemd --user';
}

/**
 * Pick systemd --user vs system unit. Prefer --user when the bus works; fall back to a
 * system unit on headless/root hosts; `--system` forces the system unit.
 */
export function chooseLinuxServiceScope({
  preferSystem = false,
  env = process.env,
  userBusAvailable = () => linuxUserBusAvailable({ env }),
  canSystem = () => canInstallLinuxSystemUnit(),
} = {}) {
  if (preferSystem) {
    if (!canSystem()) {
      throw new Error(
        'install --system needs write access to /etc/systemd/system (run as root, or use sudo).',
      );
    }
    return 'system';
  }
  if (userBusAvailable()) return 'user';
  if (canSystem()) return 'system';
  throw new Error(
    [
      'Could not reach systemd --user (no user bus). This is common on a headless VPS or root SSH session',
      '("Failed to connect to bus: No medium found" / missing XDG_RUNTIME_DIR).',
      '',
      'Fix options:',
      '  1. Prefer a normal user + lingering, then reinstall:',
      '       sudo loginctl enable-linger USERNAME',
      '       # as USERNAME:',
      '       export XDG_RUNTIME_DIR=/run/user/$(id -u)',
      '       jian-remote install --gateway … --machine … --token …',
      '  2. Install a system unit (as root):',
      '       jian-remote install --system --gateway … --machine … --token …',
      '  3. Foreground smoke test (config may already be on disk from a failed install):',
      '       node ~/.config/jian-remote/jian-remote.mjs run',
    ].join('\n'),
  );
}

async function writeLinuxServiceScope(scope) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(linuxServiceScopePath, `${scope}\n`, { mode: 0o600 });
}

async function readLinuxServiceScope() {
  try {
    const text = (await readFile(linuxServiceScopePath, 'utf8')).trim();
    if (text === 'system' || text === 'user') return text;
  } catch {
    // absent or unreadable — fall through to heuristics
  }
  if (existsSync(LINUX_SYSTEM_UNIT_PATH)) return 'system';
  return 'user';
}

/**
 * Fresh `install` probes the bus (and honors `--system`). Later start/restart/update/configure
 * keep the saved scope so a system-unit VPS install does not flip back if a user bus appears.
 */
async function resolveLinuxInstallScope() {
  const preferSystem = args.includes('--system');
  if (preferSystem) return chooseLinuxServiceScope({ preferSystem: true });
  const command = parseCliInvocation(args).command;
  if (command && command !== 'install') {
    try {
      const saved = (await readFile(linuxServiceScopePath, 'utf8')).trim();
      if (saved === 'system') {
        if (canInstallLinuxSystemUnit()) return 'system';
      } else if (saved === 'user' && linuxUserBusAvailable()) {
        return 'user';
      }
    } catch {
      // choose below
    }
  }
  return chooseLinuxServiceScope({ preferSystem: false });
}

export function buildLinuxServiceUnit({
  script,
  scope,
  home = homedir(),
  nodePath = process.execPath,
  uid = typeof process.getuid === 'function' ? process.getuid() : 0,
  username,
} = {}) {
  const quote = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const wantedBy = scope === 'system' ? 'multi-user.target' : 'default.target';
  const lines = [
    '[Unit]',
    'Description=Jian Remote worker',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${quote(nodePath)} ${quote(script)} run`,
    'Restart=always',
    'RestartSec=3',
    // System units do not inherit the installing shell's HOME; pin it so config stays findable.
    `Environment=${quote(`HOME=${home}`)}`,
    `WorkingDirectory=${quote(home)}`,
  ];
  if (scope === 'system' && uid !== 0) {
    let name = username;
    if (!name) {
      try {
        name = userInfo().username;
      } catch {
        name = undefined;
      }
    }
    if (name) lines.push(`User=${name}`);
  }
  lines.push('', '[Install]', `WantedBy=${wantedBy}`, '');
  return lines.join('\n');
}

export function serviceKindForPlatform(platform = process.platform, linuxScope = 'user') {
  if (platform === 'darwin') return 'LaunchAgent';
  if (platform === 'linux') return linuxServiceKind(linuxScope);
  if (platform === 'win32') return 'Task Scheduler';
  return 'none';
}

/**
 * Fully stop the OS service and any worker still holding the pid lock.
 * Clear success/failure for the `jian-remote stop` CLI.
 */
async function stopService() {
  const linuxScope = process.platform === 'linux' ? await readLinuxServiceScope() : 'user';
  const kind = serviceKindForPlatform(process.platform, linuxScope);
  if (process.platform === 'darwin') {
    const plistPath = macosPlistPath();
    const domain = `gui/${process.getuid()}`;
    spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    spawnSync('launchctl', ['bootout', `${domain}/${MACOS_LAUNCH_AGENT_LABEL}`], {
      stdio: 'ignore',
    });
  } else if (process.platform === 'linux') {
    if (linuxScope === 'system') {
      spawnSync('systemctl', ['stop', LINUX_SERVICE_UNIT], { stdio: 'ignore' });
    } else {
      spawnSync('systemctl', ['--user', 'stop', LINUX_SERVICE_UNIT], { stdio: 'ignore' });
    }
  } else if (process.platform === 'win32') {
    spawnSync('schtasks.exe', ['/End', '/TN', WINDOWS_TASK_NAME], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    throw new Error(`Service stop is unsupported on ${process.platform}.`);
  }

  const locked = readWorkerLockPid();
  if (locked) {
    const result = terminateWorkerPid(locked);
    if (!result.stopped) {
      throw new Error(
        `Stopped the ${kind} job but worker pid ${locked} is still running. Try again or kill it manually.`,
      );
    }
  }
  await releaseWorkerLock({ pid: locked ?? process.pid });
  // Also clear a lock we never owned (stop from a CLI process).
  try {
    await unlink(workerLockPath);
  } catch {
    // absent
  }
  return { service: kind, stopped: true };
}

/**
 * Register (if needed) and start exactly one worker. Always stops any previous instance first.
 * On macOS, ProgramArguments[0] is the Jian Remote.app Node copy — not system node — so
 * Login Items / TCC show "Jian Remote".
 */
async function startService(script = installedScript) {
  try {
    await stopService();
  } catch (error) {
    // First install / never registered: stop may complain on exotic platforms only.
    // A live pid that will not die must still fail the start.
    if (error instanceof Error && /still running/i.test(error.message)) throw error;
  }

  try {
    await readFile(script);
  } catch {
    throw new Error(
      `No installed worker at ${script}. Run: jian-remote install --gateway … --machine … --token …`,
    );
  }

  if (process.platform === 'darwin') {
    const launchAgents = join(homedir(), 'Library', 'LaunchAgents');
    const plistPath = macosPlistPath();
    const app = await materializeMacosAppRuntime();
    await mkdir(launchAgents, { recursive: true, mode: 0o700 });
    await writeFile(
      plistPath,
      buildLaunchAgentPlist({
        label: MACOS_LAUNCH_AGENT_LABEL,
        executable: app.executable,
        script,
        logPath: join(configDir, 'worker.log'),
      }),
      { mode: 0o600 },
    );
    const domain = `gui/${process.getuid()}`;
    // bootout again after writing the plist so KeepAlive cannot resurrect the old definition.
    spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    sleepMs(400);
    const loaded = spawnSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
    if (loaded.status !== 0) throw new Error('Could not start Jian Remote with launchd');
    return {
      service: 'LaunchAgent',
      detail: `Login Items identity: ${MACOS_APP_NAME}.app (${app.appRoot})`,
    };
  }
  if (process.platform === 'linux') {
    const scope = await resolveLinuxInstallScope();
    const unitBody = buildLinuxServiceUnit({ script, scope });
    if (scope === 'system') {
      // Drop a leftover user unit so stop/start do not fight two managers.
      spawnSync('systemctl', ['--user', 'disable', '--now', LINUX_SERVICE_UNIT], {
        stdio: 'ignore',
      });
      try {
        await unlink(linuxUserUnitPath());
      } catch {
        // absent
      }
      await writeFile(LINUX_SYSTEM_UNIT_PATH, unitBody, { mode: 0o644 });
      await writeLinuxServiceScope('system');
      for (const command of [['daemon-reload'], ['enable', '--now', LINUX_SERVICE_UNIT]]) {
        const result = spawnSync('systemctl', command, { stdio: 'inherit' });
        if (result.status !== 0) {
          throw new Error('Could not install/start Jian Remote with systemd (system unit)');
        }
      }
      if (!args.includes('--system') && parseCliInvocation(args).command === 'install') {
        printInfo(
          'systemd --user bus unavailable; installed a system unit instead (headless/root). Prefer a normal user + loginctl enable-linger when you can.',
        );
      }
      return { service: linuxServiceKind('system'), detail: LINUX_SYSTEM_UNIT_PATH };
    }

    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    await mkdir(unitDir, { recursive: true, mode: 0o700 });
    await writeFile(linuxUserUnitPath(), unitBody, { mode: 0o600 });
    await writeLinuxServiceScope('user');
    // Best-effort: clear a previous system install if this user can.
    if (existsSync(LINUX_SYSTEM_UNIT_PATH) && canInstallLinuxSystemUnit()) {
      spawnSync('systemctl', ['disable', '--now', LINUX_SERVICE_UNIT], { stdio: 'ignore' });
      try {
        await unlink(LINUX_SYSTEM_UNIT_PATH);
        spawnSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
      } catch {
        // leave system unit; user scope marker wins for this CLI
      }
    }
    for (const command of [['daemon-reload'], ['enable', '--now', LINUX_SERVICE_UNIT]]) {
      const result = spawnSync('systemctl', ['--user', ...command], { stdio: 'inherit' });
      if (result.status !== 0) {
        throw new Error(
          [
            'Could not install/start Jian Remote with systemd --user.',
            'If you see "Failed to connect to bus: No medium found", the user bus is missing',
            '(common on headless VPS / root SSH). Retry with: jian-remote install --system …',
            'or enable lingering: sudo loginctl enable-linger "$(whoami)" && export XDG_RUNTIME_DIR=/run/user/$(id -u)',
          ].join(' '),
        );
      }
    }
    return { service: linuxServiceKind('user'), detail: LINUX_SERVICE_UNIT };
  }
  if (process.platform === 'win32') {
    const action = `"${process.execPath}" "${script}" run`;
    runChecked(
      'schtasks.exe',
      [
        '/Create',
        '/SC',
        'ONLOGON',
        '/TN',
        WINDOWS_TASK_NAME,
        '/TR',
        action,
        '/F',
        '/RL',
        'LIMITED',
        '/IT',
      ],
      'Could not install the Jian Remote logon task with Task Scheduler',
    );
    runChecked(
      'schtasks.exe',
      ['/Run', '/TN', WINDOWS_TASK_NAME],
      'Could not start the Jian Remote scheduled task',
    );
    return { service: 'Task Scheduler', detail: `${WINDOWS_TASK_NAME} (ONLOGON)` };
  }
  printInfo(`Service auto-install is unsupported on ${process.platform}. Run: node ${script} run`);
  return { service: 'none', detail: process.platform };
}

async function restartService(script = installedScript) {
  // stopService is invoked inside startService; call stop first for clear CLI semantics / logs.
  await stopService().catch(() => undefined);
  return startService(script);
}

/** @deprecated use restartService — kept as the install/configure/update entry name. */
async function startOrRestartService(script) {
  return restartService(script);
}

async function printVersionAndExit() {
  console.log(PACKAGE_VERSION);
}

async function cliStop() {
  const result = await stopService();
  printSuccess('Stopped Jian Remote', [['Service', `${result.service} stopped`]]);
}

async function cliStart() {
  const started = await startService(installedScript);
  const facts = [['Service', `${started.service} started`]];
  if (started.detail) facts.push(['Identity', started.detail]);
  printSuccess('Started Jian Remote', facts);
}

async function cliRestart() {
  const started = await restartService(installedScript);
  const facts = [['Service', `${started.service} restarted`]];
  if (started.detail) facts.push(['Identity', started.detail]);
  printSuccess('Restarted Jian Remote', facts);
}

async function install() {
  const gateway = option('--gateway');
  const machineId = option('--machine');
  // Prefer an explicit --token for one-liner installs from the panel; stdin/prompt keep
  // the token out of shell history when someone installs by hand.
  const token = await readTokenOption();
  const gatewayBase = parseGatewayBase(gateway);
  if (!gatewayBase || !MACHINE_ID.test(machineId ?? '') || !token?.trim()) {
    throw new Error(
      'Usage: jian-remote install [--system] --gateway https://... --machine UUID (--token VALUE | --token-prompt | --token-stdin)',
    );
  }
  const gatewayVersion = await assertCompatibleWithGateway(gatewayBase);
  const config = {
    gateway: gatewayBase,
    machineId,
    token: token.trim(),
  };
  await writeConfigFile(config);
  const script = await materializeWorkerScript();
  const started = await startOrRestartService(script);
  const facts = [
    ['Service', `${started.service} started`],
    ['Config', configPath],
  ];
  if (gatewayVersion) {
    const release = parseRelease(gatewayVersion);
    facts.push(['Gateway', `${gatewayVersion} (major.minor ${release?.major}.${release?.minor})`]);
  }
  if (started.detail) facts.push(['Identity', started.detail]);
  printSuccess('Installed Jian Remote', facts);
  printInfo('Upgrade later: npx @jian-ai/remote-control@latest update  (no token again)');
  printInfo('Change URL or token: jian-remote configure --gateway … --token …');
  printInfo(
    'If Offline sticks: update or restart the service; check ~/.config/jian-remote/worker.log',
  );
}

/**
 * Rewrite stored credentials (gateway URL, worker token, and/or machine id) and restart the
 * existing OS service — does not wipe the LaunchAgent / systemd unit / scheduled task.
 */
async function configure() {
  const gatewayFlag = option('--gateway');
  const machineFlag = option('--machine');
  const tokenFlag =
    option('--token') !== undefined ||
    args.includes('--token-stdin') ||
    args.includes('--token-prompt');
  if (!gatewayFlag && !machineFlag && !tokenFlag) {
    throw new Error(
      'Usage: jian-remote configure [--gateway https://...] [--machine UUID] (--token VALUE | --token-prompt | --token-stdin)\nChange at least one of gateway, machine, or token. Reads ~/.config/jian-remote; restarts the service.',
    );
  }
  const existing = await loadConfig();

  const gatewayBase = gatewayFlag ? parseGatewayBase(gatewayFlag) : undefined;
  if (gatewayFlag && !gatewayBase) {
    throw new Error('Gateway must be an https:// URL with no credentials, query, or hash.');
  }
  const machineId = machineFlag ?? existing.machineId;
  if (!MACHINE_ID.test(machineId ?? '')) {
    throw new Error('Machine id must be a UUID.');
  }
  const token = tokenFlag ? await readTokenOption() : existing.token;
  if (!token?.trim()) {
    throw new Error('Worker token must not be empty.');
  }

  const config = {
    gateway: gatewayBase ?? existing.gateway,
    machineId,
    token: token.trim(),
  };
  if (typeof config.gateway !== 'string' || !config.gateway.startsWith('https://')) {
    throw new Error(`Invalid gateway in ${configPath}; re-run install from the panel.`);
  }

  const gatewayVersion = await assertCompatibleWithGateway(config.gateway);
  await writeConfigFile(config);
  // Prefer the already-installed script so configure does not depend on the npx cache.
  let script = installedScript;
  try {
    await readFile(script);
  } catch {
    script = await materializeWorkerScript();
  }
  const started = await startOrRestartService(script);

  const changed = [
    gatewayFlag ? 'gateway' : null,
    machineFlag ? 'machine' : null,
    tokenFlag ? 'token' : null,
  ].filter(Boolean);
  const facts = [
    ['Changed', changed.join(', ')],
    ['Config', configPath],
    ['Service', `${started.service} restarted`],
  ];
  if (gatewayVersion) {
    const release = parseRelease(gatewayVersion);
    facts.push(['Gateway', `${gatewayVersion} (major.minor ${release?.major}.${release?.minor})`]);
  }
  printSuccess('Configured Jian Remote', facts);
}

/**
 * Refresh the installed worker from npm (or this process when already the right build), using
 * credentials already stored under ~/.config/jian-remote — never re-ask for token/machine/gateway.
 */
async function update() {
  const config = await loadConfig();
  if (typeof config.gateway !== 'string' || !config.gateway.startsWith('https://')) {
    throw new Error(`Invalid gateway in ${configPath}; re-run install from the panel.`);
  }
  const gatewayVersion = await fetchGatewayVersion(config.gateway);
  const requested = option('--version');
  const target = requested?.trim() || gatewayVersion || 'latest';

  let scriptBytes;
  let installedVersion = PACKAGE_VERSION;
  // When this process already matches the target (typical: npx @jian-ai/remote-control@X update),
  // copy ourselves. Require an **exact** semver match — same major.minor alone used to let a
  // global 0.8.1 CLI rewrite the installed script while the gateway was already on 0.8.2,
  // fighting auto-update and flip-flopping two pollers.
  const selfMatchesTarget =
    target === 'latest'
      ? !isDevVersion(PACKAGE_VERSION)
      : PACKAGE_VERSION === target.replace(/^v/, '');

  if (selfMatchesTarget && !isDevVersion(PACKAGE_VERSION)) {
    scriptBytes = await readFile(fileURLToPath(import.meta.url));
    installedVersion = PACKAGE_VERSION;
  } else {
    // Prefer the gateway’s stamped script when targeting that release — works when npm has not
    // published the version yet. Fall back to npm pack for pins / latest.
    const wantGatewayScript =
      gatewayVersion &&
      target !== 'latest' &&
      parseRelease(target)?.raw === parseRelease(gatewayVersion)?.raw;
    if (wantGatewayScript) {
      try {
        printInfo('Downloading worker script from the gateway…');
        scriptBytes = await fetchGatewayWorkerScript(config.gateway);
        installedVersion = readEmbeddedVersion(scriptBytes.toString('utf8'));
      } catch (error) {
        printInfo(
          `Gateway script download failed (${error instanceof Error ? error.message : error}); trying npm…`,
        );
      }
    }
    if (!scriptBytes) {
      printInfo(`Downloading @jian-ai/remote-control@${target}…`);
      scriptBytes = fetchNpmWorkerScript(target);
      installedVersion = readEmbeddedVersion(scriptBytes.toString('utf8'));
    }
  }

  const error = compatibilityError(installedVersion, gatewayVersion);
  if (error) throw new Error(error);

  const script = await materializeWorkerScript(scriptBytes);

  // Keep a global install in sync when the operator uses the jian-remote bin from PATH.
  const npmInstall = spawnSync(
    'npm',
    ['install', '-g', `@jian-ai/remote-control@${target === 'latest' ? installedVersion : target}`],
    { stdio: 'inherit', windowsHide: true },
  );
  if (npmInstall.status !== 0) {
    printInfo(
      'Global npm install skipped or failed; the service still uses ~/.config/jian-remote/jian-remote.mjs.',
    );
  }

  const started = await startOrRestartService(script);
  const facts = [
    ['Version', installedVersion],
    ['Service', `${started.service} restarted`],
  ];
  if (gatewayVersion) facts.push(['Gateway', gatewayVersion]);
  if (started.detail) facts.push(['Identity', started.detail]);
  printSuccess('Updated Jian Remote', facts);
}

/** Absolute shell path for remote commands — never rely on PATH for the shell itself. */
export function shellCommandForPlatform(platform = process.platform) {
  if (platform === 'win32') return 'powershell.exe';
  if (existsSync('/bin/sh')) return '/bin/sh';
  if (existsSync('/bin/bash')) return '/bin/bash';
  if (existsSync('/usr/bin/sh')) return '/usr/bin/sh';
  return '/bin/sh';
}

/**
 * Resolve the working directory for a remote shell task.
 * libuv reports a missing cwd as `spawn /bin/sh ENOENT` even when the shell exists — Computer
 * Use kept working (no cwd) while run_remote_command failed. Fall back to $HOME when the
 * requested path is missing or not a directory, and surface an English note in stderr.
 */
export function resolveShellCwd(
  requested,
  { home = homedir(), exists = existsSync, stat = statSync } = {},
) {
  const fallbackCandidates = [home, process.env.TMPDIR, '/tmp', '/'].filter(Boolean);
  const fallback =
    fallbackCandidates.find((path) => {
      try {
        return exists(path) && stat(path).isDirectory();
      } catch {
        return false;
      }
    }) || '/';

  if (requested == null || requested === '') {
    return { cwd: fallback, note: undefined, usedFallback: false };
  }
  const target = String(requested).trim();
  if (!target) {
    return { cwd: fallback, note: undefined, usedFallback: false };
  }
  try {
    if (!exists(target)) {
      return {
        cwd: fallback,
        note: `Requested cwd ${target} does not exist on this computer; using ${fallback}.`,
        usedFallback: true,
      };
    }
    if (!stat(target).isDirectory()) {
      return {
        cwd: fallback,
        note: `Requested cwd ${target} is not a directory; using ${fallback}.`,
        usedFallback: true,
      };
    }
    return { cwd: target, note: undefined, usedFallback: false };
  } catch {
    return {
      cwd: fallback,
      note: `Requested cwd ${target} is not usable; using ${fallback}.`,
      usedFallback: true,
    };
  }
}

/** Env for shell / helper children: always a usable PATH and HOME. */
export function workerChildEnv(baseEnv = process.env) {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const current = baseEnv[pathKey] ?? baseEnv.PATH ?? '';
  const prefix = process.platform === 'win32' ? '' : LAUNCH_AGENT_PATH;
  const merged = prefix ? `${prefix}${current ? `:${current}` : ''}` : current || LAUNCH_AGENT_PATH;
  const home = baseEnv.HOME || baseEnv.USERPROFILE || homedir();
  return {
    ...baseEnv,
    [pathKey]: merged,
    PATH: merged,
    HOME: home,
    ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
  };
}

/**
 * Explain spawn failures. Node’s `spawn /bin/sh ENOENT` usually means the **cwd** was missing,
 * not that /bin/sh vanished — rewrite so operators and agents can act on it.
 */
export function formatShellSpawnError(error, { shell, cwd } = {}) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT' || /\bENOENT\b/.test(message)) {
    const shellMissing = shell && !existsSync(shell);
    if (shellMissing) {
      return `Could not find the shell executable ${shell}. Install a POSIX shell or reinstall Jian Remote.`;
    }
    return `Could not start the remote shell (${shell || '/bin/sh'}) with cwd ${cwd || '(unknown)'}: the working directory is missing or not usable (Node reports this as spawn ENOENT even when the shell exists).`;
  }
  return message;
}

/**
 * Run a remote shell task. Exported for behavior tests (cwd fallback, absolute shell, PATH).
 */
export function executeShellTask(task, { spawnImpl = spawn, platform = process.platform } = {}) {
  return new Promise((resolveResult) => {
    const shell = shellCommandForPlatform(platform);
    const resolved = resolveShellCwd(task.cwd);
    const commandArgs =
      platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', task.command]
        : ['-lc', task.command];
    const child = spawnImpl(shell, commandArgs, {
      cwd: resolved.cwd,
      env: workerChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = resolved.note ? `${resolved.note}\n` : '';
    let stdoutSeen = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (platform === 'win32' && child.pid) {
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          child.kill('SIGKILL');
        }
      }, 2000).unref();
    }, task.timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdoutSeen += chunk.toString('utf8').length;
      stdout = cappedAppend(stdout, chunk, STDOUT_CAP);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = cappedAppend(stderr, chunk, STDERR_CAP);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolveResult({
        taskId: task.id,
        exitCode: null,
        stdout,
        stderr: cappedAppend(
          stderr,
          formatShellSpawnError(error, { shell, cwd: resolved.cwd }),
          STDERR_CAP,
        ),
        timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (stdoutSeen > STDOUT_CAP) {
        stderr = cappedAppend(
          stderr,
          '\n[jian-remote] stdout truncated at the worker channel cap\n',
          STDERR_CAP,
        );
      }
      resolveResult({ taskId: task.id, exitCode: code, stdout, stderr, timedOut });
    });
  });
}

async function executeShell(task) {
  return executeShellTask(task);
}

async function execute(task) {
  if (task.kind === 'computer') {
    const { executeComputerTask } = await import('./computer.mjs');
    return executeComputerTask(task);
  }
  return executeShell(task);
}

async function readUpdateState() {
  try {
    const raw = JSON.parse(await readFile(updateStatePath, 'utf8'));
    return {
      failures: Number(raw?.failures) || 0,
      lastError: typeof raw?.lastError === 'string' ? raw.lastError : undefined,
      lastFailureAt: typeof raw?.lastFailureAt === 'string' ? raw.lastFailureAt : undefined,
    };
  } catch {
    return { failures: 0 };
  }
}

async function clearUpdateState() {
  try {
    rmSync(updateStatePath, { force: true });
  } catch {
    // Best-effort; a stale state file only delays the next retry.
  }
}

async function recordUpdateFailure(error) {
  const previous = await readUpdateState();
  const failures = previous.failures + 1;
  const lastError = error instanceof Error ? error.message : String(error);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    updateStatePath,
    `${JSON.stringify(
      {
        failures,
        lastError,
        lastFailureAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { failures, lastError, backoffMs: nextUpdateBackoffMs(failures) };
}

/**
 * True when this process’s PACKAGE_VERSION no longer matches the installed script on disk.
 * A surviving poller after another worker already applied an update must exit so KeepAlive
 * loads the new file — ETag 304 alone is not enough (disk matches gateway, memory is stale).
 */
export function isStaleInstalledWorker(processVersion, installedSource) {
  if (isDevVersion(processVersion)) return false;
  if (typeof installedSource !== 'string' || !installedSource) return false;
  const diskVersion = readEmbeddedVersion(installedSource);
  if (!diskVersion || diskVersion === 'unknown' || isDevVersion(diskVersion)) return false;
  return diskVersion !== processVersion;
}

/**
 * Atomically replace the installed worker script and exit so LaunchAgent / systemd KeepAlive
 * (or a detached Windows child) load the new code. Never touches config.json.
 * Does not call startOrRestartService — that would race KeepAlive and leave two pollers.
 */
async function applyWorkerScriptAndRestart(updated, { sourceLabel }) {
  const checked = validateWorkerScriptBytes(updated);
  if (!checked.ok) throw new Error(checked.message);
  // Same bytes already on disk and already loaded — do not thrash restart loops when npm and
  // the gateway script disagree about packaging but stamp the same version.
  try {
    const existing = await readFile(installedScript);
    if (
      existing.equals(Buffer.isBuffer(updated) ? updated : Buffer.from(updated)) &&
      checked.version === PACKAGE_VERSION
    ) {
      await clearUpdateState();
      return false;
    }
  } catch {
    // No installed script yet — fall through and write.
  }
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const temp = `${installedScript}.${process.pid}.tmp`;
  await writeFile(temp, updated, { mode: 0o700 });
  await rename(temp, installedScript);
  if (process.platform !== 'win32') await chmod(installedScript, 0o700);
  // Best-effort companions from this process’s package (gateway /update is main script only).
  await materializeCompanionModules();
  await clearUpdateState();
  console.log(`Worker updated to ${checked.version} from ${sourceLabel}; restarting to apply it.`);
  await releaseWorkerLock();
  if (process.platform === 'win32') {
    // Task Scheduler has no KeepAlive; spawn the new script then exit this process.
    // Only one detached child — do not also leave this process polling.
    const child = spawn(process.execPath, [installedScript, 'run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }
  // macOS LaunchAgent KeepAlive / Linux systemd Restart=always reload this path.
  process.exit(0);
}

/**
 * Pull the gateway-served worker (same bytes as /jian-remote.mjs, auth’d). Prefer this over npm
 * for fleets that can reach the gateway but not the registry.
 */
async function updateIfNeeded(base, headers) {
  const script = installedScript;
  let local;
  try {
    local = await readFile(script);
  } catch {
    local = await readFile(fileURLToPath(import.meta.url));
  }
  if (isStaleInstalledWorker(PACKAGE_VERSION, local.toString('utf8'))) {
    console.log(
      `Worker process ${PACKAGE_VERSION} is stale (installed script is newer); restarting to load it.`,
    );
    await releaseWorkerLock();
    process.exit(0);
  }
  const etag = `"${createHash('sha256').update(local).digest('hex')}"`;
  const response = await fetch(`${base}/update`, {
    headers: { ...headers, 'if-none-match': etag },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 304) {
    // Disk matches gateway. If this process is still the wrong release, exit to reload disk
    // (second poller that survived an earlier update).
    return false;
  }
  if (!response.ok) throw new Error(`worker update check failed: HTTP ${response.status}`);
  const updated = Buffer.from(await response.arrayBuffer());
  const applied = await applyWorkerScriptAndRestart(updated, { sourceLabel: 'the gateway' });
  // applyWorkerScriptAndRestart exits on a real replace; false means already current.
  return applied !== false;
}

/** Public /jian-remote.mjs — same stamped bytes as authenticated /update, no worker token. */
async function fetchGatewayWorkerScript(gatewayBase, fetcher = fetch) {
  const response = await fetcher(`${gatewayBase.replace(/\/$/, '')}/jian-remote.mjs`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Could not download gateway worker script: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Fallback when authenticated /update did not leave disk on the gateway release.
 * Prefer public /jian-remote.mjs (works when npm is not promoted yet); then npm pack.
 */
async function updateFromNpm(gatewayVersion, gatewayBase) {
  const target = parseRelease(gatewayVersion)?.raw;
  if (!target)
    throw new Error('Cannot download a worker update without a gateway release version.');
  if (gatewayBase) {
    try {
      console.log(`Downloading worker script from the gateway (/jian-remote.mjs)…`);
      const fromGateway = await fetchGatewayWorkerScript(gatewayBase);
      const applied = await applyWorkerScriptAndRestart(fromGateway, {
        sourceLabel: 'the gateway (/jian-remote.mjs)',
      });
      if (applied !== false) return true;
    } catch (error) {
      console.error(
        `Gateway script download failed (${error instanceof Error ? error.message : error}); trying npm…`,
      );
    }
  }
  console.log(`Downloading @jian-ai/remote-control@${target} from npm…`);
  const scriptBytes = fetchNpmWorkerScript(target);
  const applied = await applyWorkerScriptAndRestart(scriptBytes, {
    sourceLabel: `npm @${target}`,
  });
  return applied !== false;
}

/**
 * On connect and every few minutes: match the gateway’s worker script. Same major.minor patch
 * bumps use the authenticated /update ETag path; major.minor skew also self-updates to the
 * gateway version (gateway script first, npm fallback) instead of refusing forever.
 *
 * Prefer the gateway script. Only hit npm when the gateway path did not leave the **installed**
 * script on the gateway release — never rewrite a correct gateway install with an older npm
 * tarball (staged-but-unpublished packages caused 0.8.1↔0.8.2 thrash).
 */
async function reconcileWorkerWithGateway(config, base, headers) {
  const gatewayVersion = await fetchGatewayVersion(config.gateway);
  const gatewayRelease = parseRelease(gatewayVersion)?.raw;
  const compat = versionsCompatible(PACKAGE_VERSION, gatewayVersion);
  const mustMatch = shouldMatchGatewayVersion(PACKAGE_VERSION, gatewayVersion);

  let installedVersion;
  try {
    installedVersion = readEmbeddedVersion((await readFile(installedScript)).toString('utf8'));
  } catch {
    installedVersion = undefined;
  }

  let gatewayUpdateError;
  try {
    const changed = await updateIfNeeded(base, headers);
    // Re-read after a no-op check; updateIfNeeded exits on apply.
    try {
      installedVersion = readEmbeddedVersion((await readFile(installedScript)).toString('utf8'));
    } catch {
      // keep previous
    }
    // 304 and still wrong version → gateway bytes match disk but this process is stale, or the
    // gateway could not stamp a newer script. Fall through to npm only when disk is wrong too.
    if (!changed && mustMatch) {
      if (gatewayRelease && installedVersion === gatewayRelease) {
        console.log(
          `Installed worker is ${installedVersion} but this process is ${PACKAGE_VERSION}; restarting to load the installed script.`,
        );
        await releaseWorkerLock();
        process.exit(0);
      }
      gatewayUpdateError = new Error(
        `Gateway worker script is unchanged but this process is ${PACKAGE_VERSION} (gateway ${gatewayVersion}).`,
      );
    }
  } catch (error) {
    gatewayUpdateError = error instanceof Error ? error : new Error(String(error));
  }

  const diskAlreadyMatches = Boolean(gatewayRelease) && installedVersion === gatewayRelease;

  if (gatewayUpdateError && (mustMatch || !compat.ok) && !diskAlreadyMatches) {
    console.error(
      `Gateway self-update did not apply (${gatewayUpdateError.message}); trying npm for ${gatewayVersion}…`,
    );
    try {
      await updateFromNpm(gatewayVersion, config.gateway);
    } catch (npmError) {
      const recorded = await recordUpdateFailure(npmError);
      console.error(
        `Automatic worker update failed (${recorded.lastError}). Will retry after ${(recorded.backoffMs / 1000).toFixed(0)}s. Credentials in ${configPath} were not changed.`,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, recorded.backoffMs));
      if (!compat.ok) {
        console.error(
          compatibilityError(PACKAGE_VERSION, gatewayVersion) ??
            `This remote-control ${PACKAGE_VERSION} cannot connect to gateway ${gatewayVersion}.`,
        );
        process.exit(1);
      }
      // Compatible (same major.minor) but newer patch unavailable — keep running on the old build.
      console.error('Continuing on the installed worker; will retry the update later.');
      return gatewayVersion;
    }
  } else if (gatewayUpdateError && diskAlreadyMatches) {
    console.error(
      `Worker update check reported ${gatewayUpdateError.message}; installed script already matches gateway ${gatewayRelease}. Not rewriting from npm.`,
    );
  } else if (gatewayUpdateError) {
    // Optional content refresh failed while still compatible — log and keep polling.
    console.error(`Worker update check failed: ${gatewayUpdateError.message}`);
  }

  if (!compat.ok) {
    // Update paths returned without exiting (should be rare); refuse with backoff.
    const recorded = await recordUpdateFailure(
      new Error(`Still incompatible with gateway ${gatewayVersion} after update attempts.`),
    );
    console.error(
      compatibilityError(PACKAGE_VERSION, gatewayVersion) ??
        `This remote-control ${PACKAGE_VERSION} cannot connect to gateway ${gatewayVersion}.`,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, recorded.backoffMs));
    process.exit(1);
  }

  return gatewayVersion;
}

async function postResult(base, headers, result) {
  let { result: payload, body } = fitResult(result);
  let failures = 0;
  // full → half → minimal → stop. Never spin forever on 413; that left machines offline.
  let shrinkStage = 'full';

  while (true) {
    try {
      const saved = await fetch(`${base}/tasks/${result.taskId}/result`, {
        method: 'POST',
        redirect: 'error',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (saved.ok) return;

      if (saved.status === 413) {
        if (shrinkStage === 'full') {
          console.error(
            'result post failed: HTTP 413 (payload too large); truncating and retrying',
          );
          shrinkStage = 'half';
          ({ result: payload, body } = fitResult(payload, Math.floor(RESULT_BODY_BUDGET / 2)));
          continue;
        }
        if (shrinkStage === 'half') {
          console.error('result still too large after truncation; sending a minimal stub');
          shrinkStage = 'minimal';
          ({ result: payload, body } = fitResult(
            {
              ...payload,
              stdout: '',
              stderr:
                'Result omitted: gateway rejected the payload as too large (HTTP 413) after truncation.',
            },
            8_000,
          ));
          continue;
        }
        console.error(
          'result post rejected: HTTP 413 even for a minimal stub. Not retrying. Restart the Jian Remote service or re-run install if the machine stays offline.',
        );
        return;
      }

      if (PERMANENT_RESULT_STATUS.has(saved.status)) {
        console.error(
          `result post rejected: HTTP ${saved.status}. Not retrying. Restart the Jian Remote service or re-run install if the machine stays offline.`,
        );
        return;
      }

      throw new Error(`result post failed: HTTP ${saved.status}`);
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      if (failures >= 40) {
        console.error(
          'Gave up posting this result after repeated failures. The gateway task may stay open until the worker recovers; restart the Jian Remote service if Online stays red.',
        );
        return;
      }
      const ceiling = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.random() * ceiling));
    }
  }
}

async function run() {
  await acquireWorkerLock();
  let stopMacIdle = () => {};
  // Set once the gateway is known: tells it this worker is stopping, so the panel shows the
  // machine offline at once instead of when its last poll grows old.
  let sayGoodbye = async () => {};
  const shutdown = () => {
    try {
      stopMacIdle();
    } catch {
      // ignore
    }
    try {
      const existing = readWorkerLockPid();
      if (existing === process.pid) rmSync(workerLockPath, { force: true });
    } catch {
      // Best-effort unlock.
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void sayGoodbye().finally(() => {
        shutdown();
        process.exit(0);
      });
    });
  }
  process.once('exit', shutdown);

  const config = await loadConfig();
  const capabilities = [];
  let probeMacUiState = () => 'unknown';
  try {
    const { probeComputerCapability, computerCapabilityName } = await import('./computer.mjs');
    const name = computerCapabilityName();
    if (name && (await probeComputerCapability())) capabilities.push(name);
  } catch {
    // Computer use unavailable until helper is ready; shell tasks still work.
  }
  if (process.platform === 'darwin') {
    try {
      const mac = await import('./computer-macos.mjs');
      mac.startWorkerIdleAssertion(process.pid);
      stopMacIdle = () => mac.stopWorkerIdleAssertion();
      probeMacUiState = () => mac.probeMacUiState();
    } catch {
      // Idle assertion / uiState probe optional; shell still works.
    }
  }
  const pollHeaders = () => ({
    authorization: `Bearer ${config.token}`,
    'x-jian-platform': `${process.platform}-${process.arch}`,
    'x-jian-remote-version': PACKAGE_VERSION,
    'x-jian-remote-ui-state': probeMacUiState(),
    ...(capabilities.length ? { 'x-jian-remote-capabilities': capabilities.join(',') } : {}),
  });
  const base = `${config.gateway}/v1/remote/worker/${config.machineId}`;
  // Best effort and brief: a stop must not hang on an unreachable gateway.
  sayGoodbye = () =>
    fetch(`${base}/disconnect`, {
      method: 'POST',
      headers: pollHeaders(),
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    }).then(
      () => {},
      () => {},
    );
  // Match the gateway worker (including major.minor skew) before polling so fleets do not
  // crash-loop on refuse without attempting a self-update first.
  const gatewayVersion = await reconcileWorkerWithGateway(config, base, pollHeaders());
  console.log(
    `Connected to Jian Remote at ${config.gateway} (worker ${PACKAGE_VERSION}${gatewayVersion ? `, gateway ${gatewayVersion}` : ''}${capabilities.length ? `, capabilities ${capabilities.join(',')}` : ''})`,
  );
  let failures = 0;
  // First reconcile already ran; space the next check like the historical five-minute cadence.
  let nextUpdateCheck = Date.now() + 5 * 60_000;
  const delay = async (attempt) => {
    const ceiling = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
    const wait = Math.random() * ceiling;
    console.error(`Retrying in ${(wait / 1000).toFixed(1)}s (attempt ${attempt})…`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, wait));
  };
  while (true) {
    try {
      const headers = pollHeaders();
      if (Date.now() >= nextUpdateCheck) {
        await reconcileWorkerWithGateway(config, base, headers);
        nextUpdateCheck = Date.now() + 5 * 60_000;
      }
      const response = await fetch(`${base}/tasks/next`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 502 || response.status === 503) {
        throw new Error(`poll failed: HTTP ${response.status} (gateway temporarily unavailable)`);
      }
      if (!response.ok) throw new Error(`poll failed: HTTP ${response.status}`);
      if (failures > 0) console.log('Reconnected to Jian Remote.');
      failures = 0;
      const { task } = await response.json();
      if (!task) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
        continue;
      }
      const result = await execute(task);
      // Retry the result rather than rerunning the command after a transient network error.
      await postResult(base, headers, result);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      await delay(++failures);
    }
  }
}

/**
 * True when this file is the process entry. npm’s `.bin/jian-remote` is a symlink; comparing
 * resolve() paths alone misses that and made `npx … install` exit 0 with no stdout/stderr.
 */
export function isCliEntry(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return resolve(fileURLToPath(metaUrl)) === resolve(argv1);
  }
}

if (isCliEntry()) {
  try {
    const invocation = parseCliInvocation(args);
    if (invocation.command === 'version') await printVersionAndExit();
    else if (invocation.command === 'install') await install();
    else if (invocation.command === 'configure') await configure();
    else if (invocation.command === 'update') await update();
    else if (invocation.command === 'stop') await cliStop();
    else if (invocation.command === 'start') await cliStart();
    else if (invocation.command === 'restart') await cliRestart();
    else if (invocation.command === 'run') await run();
    else {
      const color = shouldColorize();
      const title = paint('Jian Remote', ANSI.bold, color);
      const pkg = paint('(@jian-ai/remote-control)', ANSI.dim, color);
      console.log(`${title} worker ${pkg}
  version | --version | -V
  install [--system] --gateway HTTPS_URL --machine UUID (--token VALUE | --token-prompt | --token-stdin)
  configure [--gateway HTTPS_URL] [--machine UUID] (--token VALUE | --token-prompt | --token-stdin)
  update [--version X.Y.Z|latest]
  stop | start | restart
  run

Install:    npm install -g @jian-ai/remote-control
Or:         npx @jian-ai/remote-control@latest install --gateway … --machine … --token …
            (Linux headless/root VPS: add --system, or use a normal user + loginctl enable-linger)
Configure:  jian-remote configure --token …   (or --gateway / --machine; restarts the service)
Update:     npx @jian-ai/remote-control@latest update
            (upgrades the worker binary; reads ~/.config/jian-remote)
Service:    jian-remote stop | start | restart
Version:    jian-remote version`);
    }
  } catch (error) {
    const color = shouldColorize({ isTTY: process.stderr.isTTY });
    const prefix = paint('Error', ANSI.red, color);
    console.error(`${prefix}: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
