/**
 * Computer Use on Linux (X11, or XWayland): ffmpeg's x11grab for screenshots, and a Python
 * helper that draws the Jian pointer and drives input through xdotool.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteResult, RemoteTask } from '@jian/contracts';
import { copyHelperInto, installHelperScript } from './helper-files.ts';
import { helpersRoot } from './helpers.ts';
import { ComputerSession, type Screenshot } from './session.ts';
import { COMPUTER_CAPABILITIES } from './shared.ts';
import { runComputerTask } from './task.ts';

export { imagePixelToPoint, scaleFromGeometry } from './shared.ts';

export const COMPUTER_CAPABILITY = COMPUTER_CAPABILITIES.linux;
const HELPER_NAME = 'computer-helper.py';
/** Long side of a screenshot, in px, and the JPEG size past which it is shrunk again, in bytes. */
const SHOT_LONG_SIDE = 1600;
const SHOT_BUDGET_BYTES = 280_000;

function helperPaths(home = homedir()) {
  const support = join(home, '.local', 'share', 'jian-remote');
  return {
    support,
    script: join(support, HELPER_NAME),
    stamp: join(support, `${HELPER_NAME}.sha256`),
  };
}

export function packageHelperPaths(packageRoot = helpersRoot()): { script: string } {
  return { script: join(packageRoot, 'linux', HELPER_NAME) };
}

function which(command: string): string {
  return spawnSync('which', [command], { encoding: 'utf8' }).stdout?.trim() ?? '';
}

function displayGeometry(): { width: number; height: number } {
  if (which('xdotool')) {
    const geo = spawnSync('xdotool', ['getdisplaygeometry'], { encoding: 'utf8' });
    if (geo.status === 0) {
      const [w = 0, h = 0] = (geo.stdout || '').trim().split(/\s+/).map(Number);
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

/** The pixel size ffprobe reads from an image, or undefined when it cannot. */
function imageSize(path: string): { widthPx: number; heightPx: number } | undefined {
  const identify = spawnSync(
    'ffprobe',
    [
      ...['-v', 'error', '-select_streams', 'v:0'],
      ...['-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path],
    ],
    { encoding: 'utf8' },
  );
  if (identify.status !== 0) return undefined;
  const [w = 0, h = 0] = (identify.stdout || '').trim().split('x').map(Number);
  return w > 0 && h > 0 ? { widthPx: w, heightPx: h } : undefined;
}

/** The primary display as a JPEG, long side at most 1600 px, shrunk again when over budget. */
export function capturePrimaryScreenshotBase64(): Screenshot {
  if (!which('ffmpeg')) {
    throw new Error(
      'ffmpeg is required for screenshots on Linux Jian Remote. Install ffmpeg and retry.',
    );
  }
  const display = process.env.DISPLAY;
  if (!display) {
    throw new Error('DISPLAY is not set. Computer use needs an active graphical session.');
  }
  const { width, height } = displayGeometry();
  const scale = Math.min(1, SHOT_LONG_SIDE / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const dir = mkdtempSync(join(tmpdir(), 'jian-shot.'));
  try {
    const jpg = join(dir, 'shot.jpg');
    const grabbed = spawnSync(
      'ffmpeg',
      [
        ...['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '0'],
        ...['-video_size', `${width}x${height}`, '-i', display, '-frames:v', '1'],
        ...['-vf', `scale=${outW}:${outH}`, '-q:v', '5', jpg],
      ],
      { encoding: 'utf8' },
    );
    if (grabbed.status !== 0) {
      throw new Error((grabbed.stderr || grabbed.stdout || 'Screenshot failed').trim());
    }
    // Rare at 1600 px and q5, but a busy screen can still exceed what the channel carries.
    if (statSync(jpg).size > SHOT_BUDGET_BYTES) {
      const smaller = join(dir, 'shot2.jpg');
      spawnSync(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-i', jpg, '-vf', 'scale=1280:-2', '-q:v', '7', smaller],
        { encoding: 'utf8' },
      );
      if (existsSync(smaller)) renameSync(smaller, jpg);
    }
    const size = imageSize(jpg) ?? { widthPx: outW, heightPx: outH };
    const base64 = readFileSync(jpg).toString('base64');
    if (!base64) throw new Error('Screenshot produced no image data.');
    return { base64, ...size };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ensureHelperScript(): Promise<string> {
  const paths = helperPaths();
  return installHelperScript({
    packaged: packageHelperPaths().script,
    installed: paths.script,
    stamp: paths.stamp,
  });
}

export async function materializeComputerHelperSources(configDir: string): Promise<void> {
  if (process.platform !== 'linux') return;
  await copyHelperInto(packageHelperPaths().script, [
    helperPaths().support,
    join(configDir, 'linux'),
  ]);
}

let sharedSession: ComputerSession | null = null;

export function computerSession(): ComputerSession {
  sharedSession ??= new ComputerSession({
    async launch() {
      if (!which('xdotool')) {
        throw new Error(
          'xdotool is required for Linux computer use (X11). Install xdotool and grant input access.',
        );
      }
      const script = await ensureHelperScript();
      return spawn(which('python3') || 'python3', [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
    capture: capturePrimaryScreenshotBase64,
  });
  return sharedSession;
}

export function executeComputerTask(task: RemoteTask): Promise<RemoteResult> {
  return runComputerTask(computerSession(), task);
}

/** X11 or XWayland with xdotool. Pure Wayland without xdotool is a known gap. */
export async function probeComputerCapability(): Promise<boolean> {
  if (process.platform !== 'linux' || !process.env.DISPLAY || !which('xdotool')) return false;
  try {
    await ensureHelperScript();
    return true;
  } catch {
    return false;
  }
}
