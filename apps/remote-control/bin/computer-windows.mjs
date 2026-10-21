/**
 * Windows computer-use: .NET screenshot + PowerShell helper (overlay + SendInput).
 * English-only messages. Imported by computer.mjs on win32.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPUTER_CAPABILITIES, imagePixelToPoint, scaleFromGeometry } from './computer-shared.mjs';

export { imagePixelToPoint, scaleFromGeometry } from './computer-shared.mjs';

export const COMPUTER_CAPABILITY = COMPUTER_CAPABILITIES.win32;
const IDLE_MS = 30_000;
const HELPER_NAME = 'computer-helper.ps1';

function helperPaths(home = homedir()) {
  const support = join(home, '.config', 'jian-remote', 'windows');
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
    script: join(packageRoot, 'windows', HELPER_NAME),
  };
}

function stampForBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

async function ensureHelperScript() {
  const paths = helperPaths();
  await mkdir(paths.support, { recursive: true });
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
    await writeFile(paths.script, sourceText);
    await writeFile(paths.stamp, `${hash}\n`);
  }
  return paths.script;
}

export async function materializeComputerHelperSources(configDir) {
  if (process.platform !== 'win32') return;
  try {
    const pkg = packageHelperPaths().script;
    if (!existsSync(pkg)) return;
    const support = helperPaths().support;
    await mkdir(support, { recursive: true });
    const localWin = join(configDir, 'windows');
    await mkdir(localWin, { recursive: true });
    await copyFile(pkg, join(support, HELPER_NAME));
    await copyFile(pkg, join(localWin, HELPER_NAME));
  } catch {
    // Best-effort.
  }
}

/** Primary display JPEG via PowerShell System.Drawing; scale long side ≤1600. */
export function capturePrimaryScreenshotBase64() {
  const outPath = join(tmpdir(), `jian-shot-${process.pid}-${Date.now()}.jpg`);
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$g.Dispose()
$long = [Math]::Max($b.Width, $b.Height)
$scale = if ($long -gt 1600) { 1600.0 / $long } else { 1.0 }
$w = [Math]::Max(1, [int][Math]::Round($b.Width * $scale))
$h = [Math]::Max(1, [int][Math]::Round($b.Height * $scale))
$scaled = New-Object System.Drawing.Bitmap $w, $h
$sg = [System.Drawing.Graphics]::FromImage($scaled)
$sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$sg.DrawImage($bmp, 0, 0, $w, $h)
$sg.Dispose()
$bmp.Dispose()
$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, 42L)
$scaled.Save('${outPath.replaceAll('\\', '\\\\')}', $encoder, $ep)
$scaled.Dispose()
Write-Output "$w $h"
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', maxBuffer: 600_000, windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Screenshot failed').trim());
  }
  const dims = (result.stdout || '').trim().split(/\s+/);
  const widthPx = Number(dims[0]);
  const heightPx = Number(dims[1]);
  if (!(widthPx > 0 && heightPx > 0)) throw new Error('Could not read screenshot dimensions.');
  // Recompress if oversized.
  const sizeScript = `
$p = '${outPath.replaceAll('\\', '\\\\')}'
$len = (Get-Item $p).Length
if ($len -gt 280000) {
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($p)
  $nw = [Math]::Max(1, [int]($img.Width * 0.8))
  $nh = [Math]::Max(1, [int]($img.Height * 0.8))
  $scaled = New-Object System.Drawing.Bitmap $nw, $nh
  $sg = [System.Drawing.Graphics]::FromImage($scaled)
  $sg.DrawImage($img, 0, 0, $nw, $nh)
  $sg.Dispose(); $img.Dispose()
  $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, 34L)
  $tmp = $p + '.tmp'
  $scaled.Save($tmp, $encoder, $ep)
  $scaled.Dispose()
  Move-Item -Force $tmp $p
  Write-Output "$nw $nh"
} else {
  Write-Output "${widthPx} ${heightPx}"
}
`;
  const resized = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', sizeScript],
    { encoding: 'utf8', windowsHide: true },
  );
  let finalW = widthPx;
  let finalH = heightPx;
  if (resized.status === 0) {
    const parts = (resized.stdout || '').trim().split(/\s+/).map(Number);
    if (parts[0] > 0 && parts[1] > 0) {
      finalW = parts[0];
      finalH = parts[1];
    }
  }
  const bytes = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${outPath.replaceAll('\\', '\\\\')}'))`,
    ],
    { encoding: 'utf8', maxBuffer: 600_000, windowsHide: true },
  );
  try {
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Remove-Item -Force -ErrorAction SilentlyContinue '${outPath.replaceAll('\\', '\\\\')}'`,
      ],
      { windowsHide: true },
    );
  } catch {
    // ignore
  }
  if (bytes.status !== 0 || !bytes.stdout?.trim()) {
    throw new Error('Screenshot produced no image data.');
  }
  return { base64: bytes.stdout.replace(/\s+/g, ''), widthPx: finalW, heightPx: finalH };
}

export class WindowsComputerSession {
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
    const script = await ensureHelperScript();
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
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
      this.child.kill();
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
  if (!sharedSession) sharedSession = new WindowsComputerSession();
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
  if (process.platform !== 'win32') return false;
  try {
    await ensureHelperScript();
    return true;
  } catch {
    return existsSync(helperPaths().script);
  }
}
