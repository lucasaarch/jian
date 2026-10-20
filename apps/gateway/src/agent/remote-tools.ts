import { randomUUID } from 'node:crypto';
import type { Run } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { Remote } from '../remote/service.js';
import type { Store } from '../storage/database.js';
import { mediaAssets } from '../storage/schema.js';

/** Soft ceiling for a remote screenshot or file pull through the worker’s stdout channel. */
const REMOTE_PAYLOAD_CHARS = 400_000;

function platformOf(machine: { platform: string }) {
  const value = machine.platform.toLowerCase();
  if (value.startsWith('win')) return 'windows' as const;
  if (value.startsWith('darwin') || value.includes('mac')) return 'macos' as const;
  return 'linux' as const;
}

function screenshotCommand(platform: 'windows' | 'macos' | 'linux') {
  if (platform === 'windows') {
    // JPEG to keep the base64 under the worker stdout ceiling on a typical desktop.
    return [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
      '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
      '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;',
      '$graphics = [System.Drawing.Graphics]::FromImage($bitmap);',
      '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);',
      '$stream = New-Object System.IO.MemoryStream;',
      '$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |',
      '  Where-Object { $_.MimeType -eq "image/jpeg" };',
      '$quality = New-Object System.Drawing.Imaging.EncoderParameters 1;',
      '$quality.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 55L;',
      '$bitmap.Save($stream, $encoder, $quality);',
      '[Convert]::ToBase64String($stream.ToArray())',
    ].join(' ');
  }

  if (platform === 'macos') {
    return 'tmp=$(mktemp /tmp/jian-shot.XXXXXX.jpg); screencapture -x -t jpg "$tmp" && base64 < "$tmp"; rm -f "$tmp"';
  }

  return [
    'tmp=$(mktemp /tmp/jian-shot.XXXXXX.jpg);',
    'if command -v gnome-screenshot >/dev/null; then gnome-screenshot -f "$tmp";',
    'elif command -v import >/dev/null; then import -window root "$tmp";',
    'elif command -v grim >/dev/null; then grim "$tmp";',
    'else echo "No screenshot tool (gnome-screenshot, import, or grim)" >&2; exit 1; fi;',
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

/**
 * Remote Control tools: the authorized machine’s shell, plus screenshot and file transfer
 * through the worker’s polling channel (base64 on stdout — size-capped).
 */
export function remoteTools(
  run: Run,
  remote: Pick<Remote, 'listForProfile' | 'execute'>,
  store: Store,
): ToolSet {
  const tools: ToolSet = {
    list_remote_machines: tool({
      description:
        'List remote computers explicitly authorized for this agent (Remote Control). Commands and file tools run there automatically as the logged-in local user.',
      inputSchema: z.object({}),
      execute: async () => remote.listForProfile(run.profileId),
    }),
    run_remote_command: tool({
      description:
        'Run a shell command on an authorized remote computer (PowerShell on Windows, /bin/sh on macOS/Linux). Use for apps, installs, Git, builds and anything the local programming tools would do on that machine. Prefer take_remote_screenshot / pull_remote_file / push_remote_file for those jobs. Never claim success unless the result confirms it.',
      inputSchema: z.object({
        machineId: z.uuid(),
        command: z.string().min(1).max(8000),
        cwd: z.string().min(1).max(4096).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).default(30000),
      }),
      execute: async ({ machineId, command, cwd, timeoutMs }, { abortSignal }) =>
        remote.execute(run.profileId, machineId, { command, cwd, timeoutMs }, abortSignal),
    }),
    take_remote_screenshot: tool({
      description:
        'Capture the primary display of an authorized remote computer and store the JPEG in this conversation. Returns a mediaId you can send with send_file. Prefer this over inventing screenshot commands.',
      inputSchema: z.object({
        machineId: z.uuid(),
        timeoutMs: z.number().int().min(5000).max(120000).default(60000),
      }),
      execute: async ({ machineId, timeoutMs }, { abortSignal }) => {
        const machines = await remote.listForProfile(run.profileId);
        const machine = machines.find((item) => item.id === machineId);
        if (!machine) throw new GatewayError(403, 'That remote machine is not authorized');
        if (!machine.online) throw new GatewayError(503, 'Remote machine is offline');

        const platform = platformOf(machine);
        const result = await remote.execute(
          run.profileId,
          machineId,
          { command: screenshotCommand(platform), timeoutMs },
          abortSignal,
        );
        if (result.timedOut || result.exitCode !== 0) {
          return {
            ok: false,
            platform,
            exitCode: result.exitCode,
            stderr: result.stderr,
            timedOut: result.timedOut,
          };
        }

        const base64 = result.stdout.replace(/\s+/g, '');
        if (!base64 || base64.length > REMOTE_PAYLOAD_CHARS) {
          return {
            ok: false,
            error:
              base64.length > REMOTE_PAYLOAD_CHARS
                ? 'Screenshot is too large for the worker channel; lower display scale or ask the owner.'
                : 'Screenshot produced no image data.',
            stderr: result.stderr,
          };
        }

        let bytes: Buffer;
        try {
          bytes = Buffer.from(base64, 'base64');
        } catch {
          return {
            ok: false,
            error: 'Screenshot output was not valid base64.',
            stderr: result.stderr,
          };
        }
        if (bytes.length < 32) {
          return { ok: false, error: 'Screenshot was empty.', stderr: result.stderr };
        }

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
          data: base64,
          bytes: bytes.length,
        });

        return {
          ok: true,
          mediaId,
          name,
          bytes: bytes.length,
          machineId,
          machineName: machine.name,
          hint: 'Send it in this chat with send_file using this mediaId.',
        };
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
        const machines = await remote.listForProfile(run.profileId);
        const machine = machines.find((item) => item.id === machineId);
        if (!machine) throw new GatewayError(403, 'That remote machine is not authorized');
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
        const machines = await remote.listForProfile(run.profileId);
        const machine = machines.find((item) => item.id === machineId);
        if (!machine) throw new GatewayError(403, 'That remote machine is not authorized');
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
