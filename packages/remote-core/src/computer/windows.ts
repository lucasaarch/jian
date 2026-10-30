/**
 * Computer Use on Windows: System.Drawing screenshots, and a PowerShell helper that draws the
 * Jian pointer and drives input through SendInput.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteResult, RemoteTask } from '@jian/contracts';
import { copyHelperInto, installHelperScript } from './helper-files.ts';
import { helpersRoot } from './helpers.ts';
import { ComputerSession, type Screenshot } from './session.ts';
import { COMPUTER_CAPABILITIES } from './shared.ts';
import { runComputerTask } from './task.ts';

export { imagePixelToPoint, scaleFromGeometry } from './shared.ts';

export const COMPUTER_CAPABILITY = COMPUTER_CAPABILITIES.win32;
const HELPER_NAME = 'computer-helper.ps1';
const POWERSHELL = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

function helperPaths(home = homedir()) {
  const support = join(home, '.config', 'jian-remote', 'windows');
  return {
    support,
    script: join(support, HELPER_NAME),
    stamp: join(support, `${HELPER_NAME}.sha256`),
  };
}

export function packageHelperPaths(packageRoot = helpersRoot()): { script: string } {
  return { script: join(packageRoot, 'windows', HELPER_NAME) };
}

/**
 * Captures the primary display to `$env:JIAN_SHOT_PATH` as a JPEG with its long side at most
 * 1600 px, re-encodes it smaller once when it is over the channel's budget, and prints its
 * final size. The path comes through the environment so no quoting can break the script.
 */
const CAPTURE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$p = $env:JIAN_SHOT_PATH
$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
function Save-Jpeg($image, $path, $quality) {
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
  $image.Save($path, $encoder, $ep)
}
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
Save-Jpeg $scaled $p 42
$scaled.Dispose()
if ((Get-Item $p).Length -gt 280000) {
  $img = [System.Drawing.Image]::FromFile($p)
  $w = [Math]::Max(1, [int]($img.Width * 0.8))
  $h = [Math]::Max(1, [int]($img.Height * 0.8))
  $smaller = New-Object System.Drawing.Bitmap $w, $h
  $sg = [System.Drawing.Graphics]::FromImage($smaller)
  $sg.DrawImage($img, 0, 0, $w, $h)
  $sg.Dispose()
  $img.Dispose()
  Save-Jpeg $smaller ($p + '.tmp') 34
  $smaller.Dispose()
  Move-Item -Force ($p + '.tmp') $p
}
Write-Output "$w $h"
`;

export function capturePrimaryScreenshotBase64(): Screenshot {
  const path = join(tmpdir(), `jian-shot-${process.pid}-${Date.now()}.jpg`);
  try {
    const result = spawnSync('powershell.exe', [...POWERSHELL, '-Command', CAPTURE_SCRIPT], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, JIAN_SHOT_PATH: path },
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'Screenshot failed').trim());
    }
    const [widthPx = 0, heightPx = 0] = (result.stdout || '').trim().split(/\s+/).map(Number);
    if (!(widthPx > 0 && heightPx > 0)) throw new Error('Could not read screenshot dimensions.');
    const base64 = existsSync(path) ? readFileSync(path).toString('base64') : '';
    if (!base64) throw new Error('Screenshot produced no image data.');
    return { base64, widthPx, heightPx };
  } finally {
    rmSync(path, { force: true });
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
  if (process.platform !== 'win32') return;
  await copyHelperInto(packageHelperPaths().script, [
    helperPaths().support,
    join(configDir, 'windows'),
  ]);
}

let sharedSession: ComputerSession | null = null;

export function computerSession(): ComputerSession {
  sharedSession ??= new ComputerSession({
    async launch() {
      const script = await ensureHelperScript();
      return spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    },
    capture: capturePrimaryScreenshotBase64,
  });
  return sharedSession;
}

export function executeComputerTask(task: RemoteTask): Promise<RemoteResult> {
  return runComputerTask(computerSession(), task);
}

/** A package that lost its helper still offers Computer Use with the copy installed before. */
export async function probeComputerCapability(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    await ensureHelperScript();
    return true;
  } catch {
    return existsSync(helperPaths().script);
  }
}
