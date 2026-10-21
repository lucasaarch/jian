/**
 * Linux computer-use: ffmpeg/x11grab screenshots + Python X11 helper (overlay + xdotool).
 * English-only messages. Imported by computer.mjs on linux.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPUTER_CAPABILITIES, imagePixelToPoint, scaleFromGeometry } from './computer-shared.mjs';

export { imagePixelToPoint, scaleFromGeometry } from './computer-shared.mjs';

export const COMPUTER_CAPABILITY = COMPUTER_CAPABILITIES.linux;
const IDLE_MS = 30_000;
const HELPER_NAME = 'computer-helper.py';

function helperPaths(home = homedir()) {
  const support = join(home, '.local', 'share', 'jian-remote');
  return {
    support,
    script: join(support, HELPER_NAME),
    stamp: join(support, `${HELPER_NAME}.sha256`),
  };
}

export function packageHelperPaths(
  packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  return {
    script: join(packageRoot, 'linux', HELPER_NAME),
  };
}

function stampForBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function hasXdotool() {
  return Boolean(spawnSync('which', ['xdotool'], { encoding: 'utf8' }).stdout?.trim());
}

function hasFfmpeg() {
  return Boolean(spawnSync('which', ['ffmpeg'], { encoding: 'utf8' }).stdout?.trim());
}

function displayGeometry() {
  if (hasXdotool()) {
    const geo = spawnSync('xdotool', ['getdisplaygeometry'], { encoding: 'utf8' });
    if (geo.status === 0) {
      const [w, h] = (geo.stdout || '').trim().split(/\s+/).map(Number);
      if (w > 0 && h > 0) return { width: w, height: h };
    }
  }
  const xd = spawnSync('xdpyinfo', [], { encoding: 'utf8' });
  if (xd.status === 0) {
    const match = /dimensions:\s+(\d+)x(\d+)/.exec(xd.stdout || '');
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }
  return { width: 1920, height: 1080 };
}

/** Primary display JPEG via ffmpeg x11grab; scale to ≤1600 long side, channel budget. */
export function capturePrimaryScreenshotBase64() {
  if (!hasFfmpeg()) {
    throw new Error(
      'ffmpeg is required for screenshots on Linux Jian Remote. Install ffmpeg and retry.',
    );
  }
  if (!process.env.DISPLAY) {
    throw new Error('DISPLAY is not set. Computer use needs an active graphical session.');
  }
  const { width, height } = displayGeometry();
  const dir = spawnSync('mktemp', ['-d', join(tmpdir(), 'jian-shot.XXXXXX')], {
    encoding: 'utf8',
  });
  const tmpDir = (dir.stdout || '').trim();
  if (dir.status !== 0 || !tmpDir) throw new Error('Could not create temp dir for screenshot.');
  const jpg = join(tmpDir, 'shot.jpg');
  const long = Math.max(width, height);
  const scale = long > 1600 ? 1600 / long : 1;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const vf = `scale=${outW}:${outH}`;
  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'x11grab',
      '-draw_mouse',
      '0',
      '-video_size',
      `${width}x${height}`,
      '-i',
      process.env.DISPLAY,
      '-frames:v',
      '1',
      '-vf',
      vf,
      '-q:v',
      '5',
      jpg,
    ],
    { encoding: 'utf8', maxBuffer: 600_000 },
  );
  if (result.status !== 0) {
    spawnSync('rm', ['-rf', tmpDir]);
    throw new Error((result.stderr || result.stdout || 'Screenshot failed').trim());
  }
  // Recompress if still over budget (rare at 1600/q5).
  const size = Number(
    spawnSync('wc', ['-c', jpg], { encoding: 'utf8' }).stdout?.trim().split(/\s+/)[0],
  );
  if (Number.isFinite(size) && size > 280_000) {
    const smaller = join(tmpDir, 'shot2.jpg');
    spawnSync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', jpg, '-vf', 'scale=1280:-2', '-q:v', '7', smaller],
      { encoding: 'utf8' },
    );
    if (existsSync(smaller)) {
      spawnSync('mv', [smaller, jpg]);
    }
  }
  const identify = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0:s=x',
      jpg,
    ],
    { encoding: 'utf8' },
  );
  let widthPx = outW;
  let heightPx = outH;
  if (identify.status === 0 && identify.stdout?.includes('x')) {
    const [w, h] = identify.stdout.trim().split('x').map(Number);
    if (w > 0 && h > 0) {
      widthPx = w;
      heightPx = h;
    }
  }
  const b64 = spawnSync('base64', ['-w', '0', jpg], { encoding: 'utf8', maxBuffer: 600_000 });
  spawnSync('rm', ['-rf', tmpDir]);
  if (b64.status !== 0 || !b64.stdout) throw new Error('Screenshot produced no image data.');
  return { base64: b64.stdout.replace(/\s+/g, ''), widthPx, heightPx };
}

async function ensureHelperScript() {
  const paths = helperPaths();
  await mkdir(paths.support, { recursive: true, mode: 0o755 });
  const pkg = packageHelperPaths().script;
  let sourceText;
  try {
    sourceText = await readFile(pkg, 'utf8');
  } catch {
    try {
      sourceText = await readFile(paths.script, 'utf8');
    } catch {
      throw new Error(
        'Computer-use helper is missing from this install. Reinstall or update @jian-ai/remote-control.',
      );
    }
  }
  const hash = stampForBytes(Buffer.from(sourceText, 'utf8'));
  let previous = '';
  try {
    previous = (await readFile(paths.stamp, 'utf8')).trim();
  } catch {
    previous = '';
  }
  if (previous !== hash || !existsSync(paths.script)) {
    await writeFile(paths.script, sourceText, { mode: 0o755 });
    await writeFile(paths.stamp, `${hash}\n`, { mode: 0o644 });
  }
  await chmod(paths.script, 0o755);
  return paths.script;
}

export async function materializeComputerHelperSources(configDir) {
  if (process.platform !== 'linux') return;
  try {
    const pkg = packageHelperPaths().script;
    if (!existsSync(pkg)) return;
    const support = helperPaths().support;
    await mkdir(support, { recursive: true, mode: 0o755 });
    const localLinux = join(configDir, 'linux');
    await mkdir(localLinux, { recursive: true, mode: 0o755 });
    await copyFile(pkg, join(support, HELPER_NAME));
    await copyFile(pkg, join(localLinux, HELPER_NAME));
    await chmod(join(support, HELPER_NAME), 0o755);
    await chmod(join(localLinux, HELPER_NAME), 0o755);
  } catch {
    // Best-effort.
  }
}

export class LinuxComputerSession {
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
      this.bumpIdle();
      return;
    }
    if (!hasXdotool()) {
      throw new Error(
        'xdotool is required for Linux computer use (X11). Install xdotool and grant input access.',
      );
    }
    const script = await ensureHelperScript();
    const python =
      spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout?.trim() || 'python3';
    this.child = spawn(python, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
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

    if (action === 'screenshot') {
      await this.ensure();
      const shot = capturePrimaryScreenshotBase64();
      if (!this.geometry) throw new Error('Display geometry unavailable.');
      this.shotGeometry = {
        ...this.geometry,
        widthPx: shot.widthPx,
        heightPx: shot.heightPx,
      };
      this.bumpIdle();
      return {
        exitCode: 0,
        stdout: shot.base64,
        stderr: '',
        timedOut: false,
        computer: {
          ok: true,
          widthPx: shot.widthPx,
          heightPx: shot.heightPx,
          scale: scaleFromGeometry(this.shotGeometry),
        },
      };
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
      return {
        exitCode: 1,
        stdout: '',
        stderr: message,
        timedOut: false,
        computer: { ok: false, error: message },
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
  if (!sharedSession) sharedSession = new LinuxComputerSession();
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

export async function probeComputerCapability() {
  if (process.platform !== 'linux') return false;
  // X11 (or XWayland) + xdotool. Pure Wayland without xdotool is a documented gap.
  if (!process.env.DISPLAY) return false;
  if (!hasXdotool()) return false;
  try {
    await ensureHelperScript();
    return true;
  } catch {
    return false;
  }
}
