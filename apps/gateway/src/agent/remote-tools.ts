import { randomUUID } from 'node:crypto';
import type { Run } from '@jian/contracts';
import { remoteComputerActionSchema } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { Remote } from '../remote/service.js';
import type { Store } from '../storage/database.js';
import { mediaAssets } from '../storage/schema.js';

/**
 * Soft ceiling for a remote screenshot or file pull through the worker’s stdout channel.
 * Matches packages/contracts remoteResultSchema stdout max and the worker STDOUT_CAP.
 * Prefer compressing/scaling captures so they fit — truncating base64 mid-stream yields a
 * corrupt JPEG (often a grey lower half) that still “looks like” an image.
 */
const REMOTE_PAYLOAD_CHARS = 400_000;

function platformOf(machine: { platform: string }) {
  const value = machine.platform.toLowerCase();
  if (value.startsWith('win')) return 'windows' as const;
  if (value.startsWith('darwin') || value.includes('mac')) return 'macos' as const;
  return 'linux' as const;
}

/** JPEG SOI…EOI — truncated channel payloads usually lack EOI and decode as grey garbage. */
export function isCompleteJpeg(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

export function validateScreenshotBase64(
  raw: string,
  maxChars = REMOTE_PAYLOAD_CHARS,
): { ok: true; bytes: Buffer; base64: string } | { ok: false; error: string } {
  const base64 = raw.replace(/\s+/g, '');
  if (!base64) return { ok: false, error: 'Screenshot produced no image data.' };
  if (base64.length > maxChars) {
    return {
      ok: false,
      error:
        'Screenshot is too large for the worker channel; the capture should have been scaled down. Retry or lower display scale.',
    };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return { ok: false, error: 'Screenshot output was not valid base64.' };
  }
  if (bytes.length < 4) {
    return { ok: false, error: 'Screenshot was empty.' };
  }
  // Truncated stdout cuts base64 mid-stream → incomplete JPEG (grey lower half in WhatsApp etc.).
  if (!isCompleteJpeg(bytes)) {
    return {
      ok: false,
      error:
        'Screenshot looks truncated or corrupt (incomplete JPEG). The worker channel likely cut the payload — retry; captures are compressed to fit.',
    };
  }
  return { ok: true, bytes, base64 };
}

/**
 * Platform shell that captures, then scales/recompresses so base64 fits the worker channel.
 * Still used for non-macOS screenshots via run_remote_command fallbacks in tests; macOS
 * computer-use captures inside the worker. Exported for unit tests.
 */
export function screenshotCommand(platform: 'windows' | 'macos' | 'linux') {
  if (platform === 'windows') {
    return [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
      '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
      '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;',
      '$graphics = [System.Drawing.Graphics]::FromImage($bitmap);',
      '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);',
      '$maxW = 1920;',
      'if ($bitmap.Width -gt $maxW -or $bitmap.Height -gt $maxW) {',
      '  $scale = [Math]::Min($maxW / $bitmap.Width, $maxW / $bitmap.Height);',
      '  $w = [int]([Math]::Max(1, $bitmap.Width * $scale));',
      '  $h = [int]([Math]::Max(1, $bitmap.Height * $scale));',
      '  $scaled = New-Object System.Drawing.Bitmap $w, $h;',
      '  $g2 = [System.Drawing.Graphics]::FromImage($scaled);',
      '  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
      '  $g2.DrawImage($bitmap, 0, 0, $w, $h);',
      '  $bitmap.Dispose(); $graphics.Dispose(); $g2.Dispose();',
      '  $bitmap = $scaled;',
      '}',
      '$stream = New-Object System.IO.MemoryStream;',
      '$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |',
      '  Where-Object { $_.MimeType -eq "image/jpeg" };',
      '$quality = New-Object System.Drawing.Imaging.EncoderParameters 1;',
      '$quality.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 50L;',
      '$bitmap.Save($stream, $encoder, $quality);',
      'if ($stream.Length -gt 280000) {',
      '  $stream.SetLength(0);',
      '  $quality.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 35L;',
      '  $bitmap.Save($stream, $encoder, $quality);',
      '}',
      '[Convert]::ToBase64String($stream.ToArray())',
    ].join(' ');
  }

  if (platform === 'macos') {
    // Primary display only (-D 1) so coordinates match computer-use mapping.
    return [
      'tmp=$(mktemp /tmp/jian-shot.XXXXXX.jpg);',
      'screencapture -x -t jpg -D 1 "$tmp" || { rm -f "$tmp"; exit 1; };',
      'sips -Z 1920 -s format jpeg -s formatOptions 50 "$tmp" >/dev/null 2>&1 || true;',
      'size=$(wc -c < "$tmp" | tr -d " ");',
      'if [ "$size" -gt 280000 ]; then sips -Z 1440 -s format jpeg -s formatOptions 40 "$tmp" >/dev/null 2>&1 || true; fi;',
      'size=$(wc -c < "$tmp" | tr -d " ");',
      'if [ "$size" -gt 280000 ]; then sips -Z 1280 -s format jpeg -s formatOptions 35 "$tmp" >/dev/null 2>&1 || true; fi;',
      'base64 < "$tmp"; rm -f "$tmp"',
    ].join(' ');
  }

  return [
    'tmp=$(mktemp /tmp/jian-shot.XXXXXX.jpg);',
    'if command -v gnome-screenshot >/dev/null; then gnome-screenshot -f "$tmp";',
    'elif command -v import >/dev/null; then import -window root "$tmp";',
    'elif command -v grim >/dev/null; then grim "$tmp";',
    'else echo "No screenshot tool (gnome-screenshot, import, or grim)" >&2; exit 1; fi;',
    'if command -v magick >/dev/null; then magick "$tmp" -resize "1920x1920>" -quality 50 "$tmp";',
    'elif command -v convert >/dev/null; then convert "$tmp" -resize "1920x1920>" -quality 50 "$tmp";',
    'elif command -v ffmpeg >/dev/null; then out="$tmp.out.jpg"; ffmpeg -y -i "$tmp" -vf scale=1920:-2 -q:v 5 "$out" && mv "$out" "$tmp";',
    'fi;',
    'size=$(wc -c < "$tmp" | tr -d " ");',
    'if [ "$size" -gt 280000 ] && command -v convert >/dev/null; then convert "$tmp" -resize "1280x1280>" -quality 35 "$tmp"; fi;',
    'if [ "$size" -gt 280000 ] && command -v magick >/dev/null; then magick "$tmp" -resize "1280x1280>" -quality 35 "$tmp"; fi;',
    'base64 < "$tmp"; rm -f "$tmp"',
  ].join(' ');
}

function pullCommand(platform: 'windows' | 'macos' | 'linux', path: string) {
  const escaped = path.replaceAll("'", "''");
  if (platform === 'windows') {
    return `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${escaped}'))`;
  }
  const shellPath = path.replaceAll("'", `'\\''`);
  return `base64 < '${shellPath}'`;
}

function pushCommand(platform: 'windows' | 'macos' | 'linux', path: string, base64: string) {
  if (platform === 'windows') {
    const escapedPath = path.replaceAll("'", "''");
    return [
      `$dir = Split-Path -Parent '${escapedPath}';`,
      'if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null };',
      `[IO.File]::WriteAllBytes('${escapedPath}', [Convert]::FromBase64String('${base64}'))`,
    ].join(' ');
  }
  const shellPath = path.replaceAll("'", `'\\''`);
  return `mkdir -p "$(dirname '${shellPath}')" && printf '%s' '${base64}' | base64 -d > '${shellPath}'`;
}

const coordinateSchema = z.tuple([z.number().int(), z.number().int()]);

/**
 * Machine tools: shell, Anthropic-style computer use, and file transfer through the
 * worker polling channel. Authorization is the machine’s profile ACL — not allowShell.
 */
export function remoteTools(
  run: Run,
  remote: Pick<Remote, 'list' | 'execute' | 'executeComputer' | 'update'>,
  store: Store,
  targetMachineId?: string,
): ToolSet {
  const requireTarget = (machineId: string) => {
    if (targetMachineId && machineId !== targetMachineId) {
      throw new GatewayError(403, 'This conversation is restricted to its selected remote machine');
    }
  };
  const tools: ToolSet = {
    list_remote_machines: tool({
      description:
        'List the machines connected to this installation: the computers the owner added under Machines, with their OS (system) and platform. Every agent may use each one. Commands and computer use run there as the logged-in local user.',
      inputSchema: z.object({}),
      execute: async () => remote.list(),
    }),
    run_remote_command: tool({
      description:
        'Run a shell command on an authorized remote computer (PowerShell on Windows, /bin/sh on macOS/Linux). Use for apps, installs, Git, builds and anything the local programming tools would do on that machine. Prefer remote_computer for GUI clicks and screenshots, and pull_remote_file / push_remote_file for file transfer. Never claim success unless the result confirms it.',
      inputSchema: z.object({
        machineId: z.uuid(),
        command: z.string().min(1).max(8000),
        cwd: z.string().min(1).max(4096).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).default(30000),
      }),
      execute: async ({ machineId, command, cwd, timeoutMs }, { abortSignal }) => {
        requireTarget(machineId);
        return remote.execute(run.profileId, machineId, { command, cwd, timeoutMs }, abortSignal);
      },
    }),
    remote_computer: tool({
      description:
        'Control a connected machine (macOS, Linux X11, or Windows) with Anthropic-style actions: screenshot the primary display, move/click/drag the pointer, type text, press keys, scroll, wait, or end_session (hides the Jian overlay). Coordinates are pixels in the last screenshot image (origin top-left). Screenshot first; use returned widthPx/heightPx. Call end_session when finished with the GUI.',
      inputSchema: z.object({
        machineId: z.uuid(),
        action: remoteComputerActionSchema,
        coordinate: coordinateSchema.optional(),
        start_coordinate: coordinateSchema.optional(),
        text: z.string().min(1).max(4000).optional(),
        key: z.string().min(1).max(100).optional(),
        scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
        scroll_amount: z.number().int().min(1).max(20).optional(),
        duration: z.number().min(0).max(5).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).default(30000),
      }),
      execute: async (input, { abortSignal }) => {
        requireTarget(input.machineId);
        const machines = await remote.list();
        const machine = machines.find((item) => item.id === input.machineId);
        if (!machine) throw new GatewayError(404, 'Remote machine not found');
        if (!machine.online) throw new GatewayError(503, 'Remote machine is offline');
        // Locked is advisory (list_remote_machines.uiState). Attempt Computer Use; the
        // worker wakes the display and only fails if the OS rejects the call.

        const result = await remote.executeComputer(
          run.profileId,
          input.machineId,
          {
            action: input.action,
            coordinate: input.coordinate,
            startCoordinate: input.start_coordinate,
            text: input.text,
            key: input.key,
            scrollDirection: input.scroll_direction,
            scrollAmount: input.scroll_amount,
            duration: input.duration,
            timeoutMs: input.timeoutMs,
          },
          abortSignal,
        );

        if (input.action !== 'screenshot') {
          const computer = (
            result as {
              computer?: { ok?: boolean; error?: string };
              timedOut?: boolean;
              exitCode?: number | null;
              stderr?: string;
            }
          ).computer;
          return {
            ok: computer?.ok !== false && !result.timedOut && (result.exitCode ?? 0) === 0,
            action: input.action,
            exitCode: result.exitCode,
            stderr: result.stderr,
            timedOut: result.timedOut,
            error: computer?.error,
            machineId: input.machineId,
            machineName: machine.name,
          };
        }

        if (result.timedOut || result.exitCode !== 0) {
          return {
            ok: false,
            action: 'screenshot',
            exitCode: result.exitCode,
            stderr: result.stderr,
            timedOut: result.timedOut,
            machineId: input.machineId,
          };
        }

        const checked = validateScreenshotBase64(result.stdout, REMOTE_PAYLOAD_CHARS);
        if (!checked.ok) {
          return { ok: false, action: 'screenshot', error: checked.error, stderr: result.stderr };
        }

        const computer = (
          result as {
            computer?: {
              widthPx?: number;
              heightPx?: number;
              scale?: { imageToPointX: number; imageToPointY: number };
            };
          }
        ).computer;

        const mediaId = randomUUID();
        const name = `remote-screenshot-${machine.name.replace(/[^\w.-]+/g, '_')}.jpg`;
        await store.db.insert(mediaAssets).values({
          id: mediaId,
          profileId: run.profileId,
          sessionId: run.sessionId,
          runId: run.id,
          sourceKey: `remote-shot:${mediaId}`,
          mimeType: 'image/jpeg',
          name,
          data: checked.base64,
          bytes: checked.bytes.length,
        });

        return {
          ok: true,
          action: 'screenshot',
          mediaId,
          name,
          bytes: checked.bytes.length,
          widthPx: computer?.widthPx,
          heightPx: computer?.heightPx,
          scale: computer?.scale,
          displayId: 'primary' as const,
          machineId: input.machineId,
          machineName: machine.name,
          hint: 'Aim clicks in this image’s pixel space (widthPx × heightPx). Send with send_file using mediaId when the owner should see it.',
        };
      },
    }),
    update_remote_machine: tool({
      description:
        "Update Jian Remote on a connected computer to this gateway's release. Needed when list_remote_machines shows it outdated: no other remote tool works on it until then. Only machines with updatable: true can do it themselves; the worker restarts on the new release once it reports back. Takes up to a few minutes.",
      inputSchema: z.object({ machineId: z.uuid() }),
      execute: async ({ machineId }, { abortSignal }) => {
        requireTarget(machineId);
        return remote.update(run.profileId, machineId, abortSignal);
      },
    }),
    pull_remote_file: tool({
      description:
        'Read a file from an authorized remote computer into this conversation as media (binary via base64). For large files, prefer run_remote_command with a transfer the owner arranged. Text under a few hundred KB works best.',
      inputSchema: z.object({
        machineId: z.uuid(),
        path: z.string().min(1).max(4096),
        name: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'File name with extension for the stored attachment; defaults to the path name.',
          ),
        timeoutMs: z.number().int().min(5000).max(120000).default(60000),
      }),
      execute: async ({ machineId, path, name, timeoutMs }, { abortSignal }) => {
        requireTarget(machineId);
        const machines = await remote.list();
        const machine = machines.find((item) => item.id === machineId);
        if (!machine) throw new GatewayError(404, 'Remote machine not found');
        if (!machine.online) throw new GatewayError(503, 'Remote machine is offline');

        const platform = platformOf(machine);
        const result = await remote.execute(
          run.profileId,
          machineId,
          { command: pullCommand(platform, path), timeoutMs },
          abortSignal,
        );
        if (result.timedOut || result.exitCode !== 0) {
          return {
            ok: false,
            exitCode: result.exitCode,
            stderr: result.stderr,
            timedOut: result.timedOut,
          };
        }

        const base64 = result.stdout.replace(/\s+/g, '');
        if (!base64) return { ok: false, error: 'File was empty or unreadable.' };
        if (base64.length > REMOTE_PAYLOAD_CHARS) {
          return {
            ok: false,
            error: 'File is too large for the worker channel (roughly 300 KB binary).',
          };
        }

        const bytes = Buffer.from(base64, 'base64');
        const mediaId = randomUUID();
        const fileName = name?.trim() || path.split(/[/\\]/).pop() || 'remote-file';
        await store.db.insert(mediaAssets).values({
          id: mediaId,
          profileId: run.profileId,
          sessionId: run.sessionId,
          runId: run.id,
          sourceKey: `remote-pull:${mediaId}`,
          mimeType: 'application/octet-stream',
          name: fileName.slice(0, 200),
          data: base64,
          bytes: bytes.length,
        });

        return {
          ok: true,
          mediaId,
          name: fileName,
          bytes: bytes.length,
          hint: 'Send with send_file, or save_attachment then open with machine tools on the gateway.',
        };
      },
    }),
    push_remote_file: tool({
      description:
        'Write bytes to a path on an authorized remote computer. Pass UTF-8 text, or base64 with encoding base64. Size is capped by the worker channel.',
      inputSchema: z.object({
        machineId: z.uuid(),
        path: z.string().min(1).max(4096),
        content: z.string().min(1).max(REMOTE_PAYLOAD_CHARS),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
        timeoutMs: z.number().int().min(5000).max(120000).default(60000),
      }),
      execute: async ({ machineId, path, content, encoding, timeoutMs }, { abortSignal }) => {
        requireTarget(machineId);
        const machines = await remote.list();
        const machine = machines.find((item) => item.id === machineId);
        if (!machine) throw new GatewayError(404, 'Remote machine not found');
        if (!machine.online) throw new GatewayError(503, 'Remote machine is offline');

        const platform = platformOf(machine);
        const base64 =
          encoding === 'base64'
            ? content.replace(/\s+/g, '')
            : Buffer.from(content, 'utf8').toString('base64');
        if (base64.length > REMOTE_PAYLOAD_CHARS) {
          return { ok: false, error: 'Payload is too large for the worker channel.' };
        }

        const result = await remote.execute(
          run.profileId,
          machineId,
          { command: pushCommand(platform, path, base64), timeoutMs },
          abortSignal,
        );

        return {
          ok: result.exitCode === 0 && !result.timedOut,
          exitCode: result.exitCode,
          stderr: result.stderr,
          timedOut: result.timedOut,
          path,
          machineId,
        };
      },
    }),
  };

  return tools;
}
