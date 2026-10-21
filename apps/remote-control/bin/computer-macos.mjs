/**
 * macOS computer-use: primary-display screenshots, coord mapping, Jian overlay helper.
 * English-only messages. Imported by computer.mjs on darwin.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPUTER_CAPABILITIES, imagePixelToPoint, scaleFromGeometry } from './computer-shared.mjs';

export { imagePixelToPoint, scaleFromGeometry } from './computer-shared.mjs';

export const COMPUTER_CAPABILITY = COMPUTER_CAPABILITIES.darwin;
const IDLE_MS = 30_000;
const HELPER_NAME = 'computer-helper';
/** How long we cache lock / display-asleep probes between HTTPS polls. */
const UI_STATE_CACHE_MS = 5_000;
export const MAC_UI_STATES = Object.freeze(['unlocked', 'locked', 'display_asleep', 'unknown']);

const LOCKED_SCREENSHOT_NOTE =
  'Note: Mac session reports locked — image may be the lock screen (or black if the display stayed asleep). Desktop apps behind loginwindow are often not visible.';

const LOCKED_ACTION_HINT =
  ' Mac session reports locked; if this failed, unlock or keep the display awake (post-login lock ≠ FileVault loginwindow).';

let cachedUiState = { at: 0, state: 'unknown' };
let workerIdleCaffeinate = null;
let sessionDisplayCaffeinate = null;

/**
 * Capture primary display and compress for the worker channel.
 * Single-pass ladder starts at 1600/42 (skips a full-res 1920@50 encode that often
 * exceeded the budget and forced a second sips pass — common waste on Retina).
 */
export function capturePrimaryScreenshotBase64() {
  const script = [
    'tmp=$(mktemp /tmp/jian-shot.XXXXXX.jpg);',
    'screencapture -x -t jpg -D 1 "$tmp" || { rm -f "$tmp"; exit 1; };',
    'sips -Z 1600 -s format jpeg -s formatOptions 42 "$tmp" >/dev/null 2>&1 || true;',
    'size=$(wc -c < "$tmp" | tr -d " ");',
    'if [ "$size" -gt 280000 ]; then sips -Z 1440 -s format jpeg -s formatOptions 38 "$tmp" >/dev/null 2>&1 || true; fi;',
    'size=$(wc -c < "$tmp" | tr -d " ");',
    'if [ "$size" -gt 280000 ]; then sips -Z 1280 -s format jpeg -s formatOptions 34 "$tmp" >/dev/null 2>&1 || true; fi;',
    'w=$(sips -g pixelWidth "$tmp" 2>/dev/null | awk "/pixelWidth/{print \\$2}");',
    'h=$(sips -g pixelHeight "$tmp" 2>/dev/null | awk "/pixelHeight/{print \\$2}");',
    'echo "$w $h";',
    'base64 < "$tmp";',
    'rm -f "$tmp"',
  ].join(' ');
  const result = spawnSync('/bin/sh', ['-lc', script], {
    encoding: 'utf8',
    maxBuffer: 600_000,
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || 'Screenshot failed').trim();
    throw new Error(
      /not authorized|capture/i.test(err)
        ? 'Jian Remote needs Screen Recording permission in System Settings.'
        : err || 'Screenshot failed',
    );
  }
  const out = result.stdout || '';
  const nl = out.indexOf('\n');
  if (nl < 0) throw new Error('Screenshot produced no image data.');
  const [wRaw, hRaw] = out.slice(0, nl).trim().split(/\s+/);
  const widthPx = Number(wRaw);
  const heightPx = Number(hRaw);
  const base64 = out.slice(nl + 1).replace(/\s+/g, '');
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx < 1 || heightPx < 1) {
    throw new Error('Could not read screenshot dimensions.');
  }
  if (!base64) throw new Error('Screenshot produced no image data.');
  return { base64, widthPx, heightPx };
}

function helperPaths(home = homedir()) {
  const support = join(home, 'Library', 'Application Support', 'Jian Remote');
  return {
    support,
    source: join(support, `${HELPER_NAME}.swift`),
    binary: join(support, HELPER_NAME),
    stamp: join(support, `${HELPER_NAME}.sha256`),
  };
}

/** Paths inside the installed npm package (or a checkout). */
export function packageHelperPaths(
  packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  return {
    swift: join(packageRoot, 'macos', `${HELPER_NAME}.swift`),
    binary: join(packageRoot, 'macos', HELPER_NAME),
  };
}

function packageSwiftPath() {
  return packageHelperPaths().swift;
}

function packageBinaryPath() {
  return packageHelperPaths().binary;
}

function stampForBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** Drop download quarantine so a helper from npm can exec under the LaunchAgent. */
function clearQuarantine(path) {
  spawnSync('xattr', ['-d', 'com.apple.quarantine', path], { encoding: 'utf8' });
}

/**
 * Prefer a Publish-built universal binary from the npm package; otherwise compile with swiftc.
 * Stamp is over the installed artifact bytes so updates replace a stale helper.
 */
async function ensureHelperBinary() {
  const paths = helperPaths();
  await mkdir(paths.support, { recursive: true, mode: 0o755 });

  let previous = '';
  try {
    previous = (await readFile(paths.stamp, 'utf8')).trim();
  } catch {
    previous = '';
  }

  const packagedBinary = packageBinaryPath();
  if (existsSync(packagedBinary)) {
    const bytes = await readFile(packagedBinary);
    const hash = `bin:${stampForBytes(bytes)}`;
    if (previous !== hash || !existsSync(paths.binary)) {
      await copyFile(packagedBinary, paths.binary);
      await chmod(paths.binary, 0o755);
      clearQuarantine(paths.binary);
      await writeFile(paths.stamp, `${hash}\n`, { mode: 0o644 });
    }
    try {
      const swift = packageSwiftPath();
      if (existsSync(swift)) await copyFile(swift, paths.source);
    } catch {
      // optional
    }
    return paths.binary;
  }

  let sourceText;
  try {
    sourceText = await readFile(packageSwiftPath(), 'utf8');
  } catch {
    try {
      sourceText = await readFile(paths.source, 'utf8');
    } catch {
      throw new Error(
        'Computer-use helper is missing from this install. Reinstall or update @jian-ai/remote-control.',
      );
    }
  }
  const hash = `src:${stampForBytes(Buffer.from(sourceText, 'utf8'))}`;
  const needsBuild = previous !== hash || !existsSync(paths.binary);
  await writeFile(paths.source, sourceText, { mode: 0o644 });
  if (needsBuild) {
    const compiled = spawnSync(
      'swiftc',
      ['-O', '-framework', 'AppKit', '-framework', 'Carbon', '-o', paths.binary, paths.source],
      { encoding: 'utf8' },
    );
    if (compiled.status !== 0) {
      throw new Error(
        (compiled.stderr || compiled.stdout || 'swiftc failed').trim() ||
          'Could not build the Jian computer-use helper. Published packages ship a prebuilt helper; for source builds install Xcode Command Line Tools, or reinstall @jian-ai/remote-control.',
      );
    }
    await chmod(paths.binary, 0o755);
    clearQuarantine(paths.binary);
    await writeFile(paths.stamp, `${hash}\n`, { mode: 0o644 });
  }
  return paths.binary;
}

/** Copy Swift source and any prebuilt helper next to the installed worker. */
export async function materializeComputerHelperSources(configDir) {
  if (process.platform !== 'darwin') return;
  try {
    const pkg = packageHelperPaths();
    if (!existsSync(pkg.swift) && !existsSync(pkg.binary)) return;
    const support = join(homedir(), 'Library', 'Application Support', 'Jian Remote');
    await mkdir(support, { recursive: true, mode: 0o755 });
    const localMacos = join(configDir, 'macos');
    await mkdir(localMacos, { recursive: true, mode: 0o755 });
    if (existsSync(pkg.swift)) {
      await copyFile(pkg.swift, join(support, `${HELPER_NAME}.swift`));
      await copyFile(pkg.swift, join(localMacos, `${HELPER_NAME}.swift`));
    }
    if (existsSync(pkg.binary)) {
      const destSupport = join(support, HELPER_NAME);
      const destLocal = join(localMacos, HELPER_NAME);
      await copyFile(pkg.binary, destSupport);
      await copyFile(pkg.binary, destLocal);
      await chmod(destSupport, 0o755);
      await chmod(destLocal, 0o755);
      clearQuarantine(destSupport);
      clearQuarantine(destLocal);
      const bytes = await readFile(pkg.binary);
      await writeFile(join(support, `${HELPER_NAME}.sha256`), `bin:${stampForBytes(bytes)}\n`, {
        mode: 0o644,
      });
    }
  } catch {
    // Best-effort on install; computer session will surface a clear error.
  }
}

export class MacComputerSession {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.pending = [];
    this.geometry = null;
    this.shotGeometry = null;
    this.idleTimer = null;
    this.active = false;
  }

  async ensure() {
    if (this.child && !this.child.killed) {
      if (!this.active) {
        await this.send({ cmd: 'ensureSession' });
        this.active = true;
      }
      startSessionDisplayAssertion(this.child.pid || process.pid);
      this.bumpIdle();
      return;
    }
    const binary = await ensureHelperBinary();
    this.child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.error(text);
    });
    this.child.on('exit', () => {
      this.failAll('Computer-use helper exited unexpectedly.');
      this.child = null;
      this.active = false;
      stopSessionDisplayAssertion();
    });
    const ping = await this.send({ cmd: 'ping' });
    if (!ping.ok) throw new Error(ping.error || 'Computer-use helper did not respond.');
    const geo = await this.send({ cmd: 'geometry' });
    if (!geo.ok) throw new Error(geo.error || 'Could not read display geometry.');
    this.geometry = {
      originX: Number(geo.originX) || 0,
      originY: Number(geo.originY) || 0,
      pointWidth: Number(geo.pointWidth),
      pointHeight: Number(geo.pointHeight),
      pixelWidth: Number(geo.pixelWidth),
      pixelHeight: Number(geo.pixelHeight),
      scaleFactor: Number(geo.scaleFactor) || 1,
    };
    await this.send({ cmd: 'ensureSession' });
    this.active = true;
    startSessionDisplayAssertion(this.child.pid || process.pid);
    this.bumpIdle();
  }

  bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.active || !this.child) return;
      void this.send({ cmd: 'setIdle' }).catch(() => {});
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.failNext('Computer-use helper returned invalid JSON.');
        continue;
      }
      const next = this.pending.shift();
      if (next) next.resolve(parsed);
    }
  }

  failNext(message) {
    const next = this.pending.shift();
    if (next) next.reject(new Error(message));
  }

  failAll(message) {
    while (this.pending.length) {
      this.pending.shift().reject(new Error(message));
    }
  }

  send(payload) {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin) {
        reject(new Error('Computer-use helper is not running.'));
        return;
      }
      this.pending.push({ resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          this.pending.pop();
          reject(error);
        }
      });
    });
  }

  requireShotGeometry() {
    if (!this.shotGeometry) {
      throw new Error('Take a screenshot before using screen coordinates.');
    }
    return this.shotGeometry;
  }

  mapCoordinate(coordinate) {
    const [x, y] = coordinate;
    const shot = this.requireShotGeometry();
    if (x < 0 || y < 0 || x >= shot.widthPx || y >= shot.heightPx) {
      throw new Error(
        `Coordinate (${x}, ${y}) is outside the last screenshot (${shot.widthPx}×${shot.heightPx}).`,
      );
    }
    return imagePixelToPoint(x, y, shot);
  }

  async end() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    stopSessionDisplayAssertion();
    if (this.child) {
      try {
        await this.send({ cmd: 'endSession' });
      } catch {
        // ignore
      }
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.active = false;
    this.shotGeometry = null;
    this.geometry = null;
  }

  async runAction(computer) {
    const { action } = computer;
    if (action === 'end_session') {
      await this.end();
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        computer: { ok: true },
      };
    }

    if (action === 'wait') {
      const ms = Math.round((computer.duration ?? 0.35) * 1000);
      await new Promise((r) => setTimeout(r, ms));
      if (this.active) this.bumpIdle();
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        computer: { ok: true },
      };
    }

    // Wake display when locked/asleep, then always attempt — never soft-block on uiState.
    const uiPrep = prepareComputerUi();

    if (action === 'screenshot') {
      try {
        await this.ensure();
        const shot = capturePrimaryScreenshotBase64();
        if (!this.geometry) throw new Error('Display geometry unavailable.');
        this.shotGeometry = {
          ...this.geometry,
          widthPx: shot.widthPx,
          heightPx: shot.heightPx,
        };
        this.bumpIdle();
        const stderr = uiPrep.sessionLocked ? LOCKED_SCREENSHOT_NOTE : '';
        return {
          exitCode: 0,
          stdout: shot.base64,
          stderr,
          timedOut: false,
          computer: {
            ok: true,
            widthPx: shot.widthPx,
            heightPx: shot.heightPx,
            scale: scaleFromGeometry(this.shotGeometry),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint = uiPrep.sessionLocked ? LOCKED_ACTION_HINT : '';
        const tcc = /accessib|not permitted|not authorized|Screen Recording/i.test(message)
          ? ' Jian Remote needs Screen Recording (and Accessibility for input) in System Settings.'
          : '';
        const full = `${message}${tcc}${hint}`.trim();
        return {
          exitCode: 1,
          stdout: '',
          stderr: full,
          timedOut: false,
          computer: { ok: false, error: full },
        };
      }
    }

    await this.ensure();

    try {
      if (action === 'mouse_move') {
        if (!computer.coordinate) throw new Error('coordinate is required for this action.');
        const { pointX, pointY } = this.mapCoordinate(computer.coordinate);
        const moved = await this.send({ cmd: 'move', pointX, pointY });
        if (!moved.ok) throw new Error(moved.error || 'Move failed.');
      } else if (action === 'left_click' || action === 'right_click' || action === 'double_click') {
        if (!computer.coordinate) throw new Error('coordinate is required for this action.');
        const { pointX, pointY } = this.mapCoordinate(computer.coordinate);
        const button = action === 'right_click' ? 'right' : 'left';
        const count = action === 'double_click' ? 2 : 1;
        // One RPC: animate overlay, click, restore user cursor (helper-side).
        const clicked = await this.send({ cmd: 'clickAt', pointX, pointY, button, count });
        if (!clicked.ok) throw new Error(clicked.error || 'Click failed.');
      } else if (action === 'left_click_drag') {
        if (!computer.startCoordinate || !computer.coordinate) {
          throw new Error('startCoordinate and coordinate are required for drag.');
        }
        const from = this.mapCoordinate(computer.startCoordinate);
        const to = this.mapCoordinate(computer.coordinate);
        const dragged = await this.send({
          cmd: 'drag',
          fromX: from.pointX,
          fromY: from.pointY,
          toX: to.pointX,
          toY: to.pointY,
        });
        if (!dragged.ok) throw new Error(dragged.error || 'Drag failed.');
      } else if (action === 'type') {
        if (!computer.text) throw new Error('text is required for type.');
        const typed = await this.send({ cmd: 'type', text: computer.text });
        if (!typed.ok) throw new Error(typed.error || 'Type failed.');
      } else if (action === 'key') {
        if (!computer.key) throw new Error('key is required for key.');
        const keyed = await this.send({ cmd: 'key', key: computer.key });
        if (!keyed.ok) throw new Error(keyed.error || 'Key failed.');
      } else if (action === 'scroll') {
        if (!computer.coordinate) throw new Error('coordinate is required for scroll.');
        if (!computer.scrollDirection) throw new Error('scrollDirection is required for scroll.');
        const { pointX, pointY } = this.mapCoordinate(computer.coordinate);
        const scrolled = await this.send({
          cmd: 'scroll',
          pointX,
          pointY,
          direction: computer.scrollDirection,
          amount: computer.scrollAmount ?? 3,
        });
        if (!scrolled.ok) throw new Error(scrolled.error || 'Scroll failed.');
      } else {
        throw new Error(`Unsupported computer action: ${action}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const tcc = /accessib|not permitted|not authorized/i.test(message)
        ? ' Jian Remote needs Accessibility (and Screen Recording for screenshots) in System Settings.'
        : '';
      const hint = uiPrep.sessionLocked ? LOCKED_ACTION_HINT : '';
      const full = `${message}${tcc}${hint}`.trim();
      return {
        exitCode: 1,
        stdout: '',
        stderr: full,
        timedOut: false,
        computer: { ok: false, error: full },
      };
    }

    this.bumpIdle();
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      computer: { ok: true },
    };
  }
}

let sharedSession = null;

export function computerSession() {
  if (!sharedSession) sharedSession = new MacComputerSession();
  return sharedSession;
}

export async function executeComputerTask(task) {
  const session = computerSession();
  const computer = task.computer;
  if (!computer?.action) {
    return {
      taskId: task.id,
      exitCode: 1,
      stdout: '',
      stderr: 'Computer task missing action.',
      timedOut: false,
      computer: { ok: false, error: 'Computer task missing action.' },
    };
  }
  const timeoutMs = task.timeoutMs || 30_000;
  let timedOut = false;
  const result = await Promise.race([
    session.runAction(computer),
    new Promise((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve({
          exitCode: null,
          stdout: '',
          stderr: 'Computer action timed out',
          timedOut: true,
          computer: { ok: false, error: 'Computer action timed out' },
        });
      }, timeoutMs);
    }),
  ]);
  return { taskId: task.id, ...result, timedOut: timedOut || Boolean(result.timedOut) };
}

/** Probe whether this Mac can advertise computer-use (helper builds). */
export async function probeComputerCapability() {
  if (process.platform !== 'darwin') return false;
  try {
    await ensureHelperBinary();
    return true;
  } catch {
    return (
      Boolean(spawnSync('which', ['swiftc'], { encoding: 'utf8' }).stdout?.trim()) ||
      existsSync(helperPaths().binary)
    );
  }
}

function normalizeUiState(value) {
  return MAC_UI_STATES.includes(value) ? value : 'unknown';
}

/**
 * Lock screen vs display sleep vs unlocked. Prefer the helper binary (CGSession +
 * CGDisplayIsAsleep); fall back to unknown so we never invent "offline".
 */
export function probeMacUiState({ force = false } = {}) {
  if (process.platform !== 'darwin') return 'unknown';
  const now = Date.now();
  if (!force && now - cachedUiState.at < UI_STATE_CACHE_MS) return cachedUiState.state;

  let state = 'unknown';
  const binary = helperPaths().binary;
  if (existsSync(binary)) {
    const probed = spawnSync(binary, ['--session-status'], {
      encoding: 'utf8',
      timeout: 4_000,
      maxBuffer: 16_000,
    });
    if (probed.status === 0) {
      try {
        const line = (probed.stdout || '').trim().split('\n').pop();
        const parsed = JSON.parse(line || '{}');
        if (parsed?.ok) state = normalizeUiState(parsed.state);
      } catch {
        state = 'unknown';
      }
    }
  }

  cachedUiState = { at: now, state };
  return state;
}

/**
 * Prevent idle system sleep for the worker process so HTTPS polls keep firing when the
 * screen is locked. Does not claim lid-closed / clamshell immunity (see docs/remote.md).
 */
export function startWorkerIdleAssertion(pid = process.pid) {
  if (process.platform !== 'darwin') return null;
  stopWorkerIdleAssertion();
  try {
    workerIdleCaffeinate = spawn('/usr/bin/caffeinate', ['-i', '-w', String(pid)], {
      stdio: 'ignore',
      detached: false,
    });
    workerIdleCaffeinate.on('error', () => {
      workerIdleCaffeinate = null;
    });
    workerIdleCaffeinate.unref?.();
    return workerIdleCaffeinate;
  } catch {
    workerIdleCaffeinate = null;
    return null;
  }
}

export function stopWorkerIdleAssertion() {
  if (!workerIdleCaffeinate) return;
  try {
    workerIdleCaffeinate.kill('SIGTERM');
  } catch {
    // already gone
  }
  workerIdleCaffeinate = null;
}

/** While a computer-use session is open, also keep the display from idling off. */
function startSessionDisplayAssertion(pid = process.pid) {
  if (process.platform !== 'darwin') return;
  stopSessionDisplayAssertion();
  try {
    sessionDisplayCaffeinate = spawn('/usr/bin/caffeinate', ['-dimsu', '-w', String(pid)], {
      stdio: 'ignore',
      detached: false,
    });
    sessionDisplayCaffeinate.on('error', () => {
      sessionDisplayCaffeinate = null;
    });
    sessionDisplayCaffeinate.unref?.();
  } catch {
    sessionDisplayCaffeinate = null;
  }
}

function stopSessionDisplayAssertion() {
  if (!sessionDisplayCaffeinate) return;
  try {
    sessionDisplayCaffeinate.kill('SIGTERM');
  } catch {
    // already gone
  }
  sessionDisplayCaffeinate = null;
}

/** User-activity assertion: nudge a sleeping (unlocked) display awake. */
export function wakeMacDisplay(seconds = 3) {
  if (process.platform !== 'darwin') return;
  const secs = Math.max(1, Math.min(30, Math.round(seconds)));
  spawnSync('/usr/bin/caffeinate', ['-u', '-t', String(secs)], {
    encoding: 'utf8',
    timeout: (secs + 2) * 1000,
  });
}

/**
 * Wake the display when locked or asleep (lock often coincides with display sleep).
 * Never soft-blocks: callers always attempt the OS API next.
 */
export function prepareComputerUi() {
  let state = probeMacUiState({ force: true });
  if (state === 'display_asleep' || state === 'locked' || state === 'unknown') {
    wakeMacDisplay(3);
    state = probeMacUiState({ force: true });
  }
  return { sessionLocked: state === 'locked', state };
}
