import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { MINIMAL_PATH } from '@jian/remote-core';
import {
  clearMacQuarantine,
  collectNodeRuntimeLibraries,
  rewriteBundledMachOLinks,
} from './mach-o.ts';
import { LAUNCH_AGENT_THROTTLE_INTERVAL_SEC, MACOS_APP_NAME, MACOS_BUNDLE_ID } from './paths.ts';

function xmlEscape(value: string): string {
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

export function buildMacosAppInfoPlist(): string {
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
  pathEnv = MINIMAL_PATH,
  throttleIntervalSec = LAUNCH_AGENT_THROTTLE_INTERVAL_SEC,
  home = homedir(),
  tmpDir = process.env.TMPDIR || '/tmp',
}: {
  label: string;
  executable: string;
  script: string;
  logPath: string;
  pathEnv?: string;
  throttleIntervalSec?: number;
  home?: string;
  tmpDir?: string;
}): string {
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
}: {
  sourceNode?: string;
  home?: string;
  collectLibraries?: (nodePath: string) => string[];
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
  const libraryBasenames: string[] = [];
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
