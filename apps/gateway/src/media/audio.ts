import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { InlineMedia } from '@jian/contracts';

/** WhatsApp voice notes require Opus, while Gemini returns PCM. */
export async function voiceNote(media: InlineMedia, signal: AbortSignal): Promise<InlineMedia> {
  if (media.mimeType === 'audio/ogg') return { ...media, voice: true };
  const directory = await mkdtemp(join(tmpdir(), 'jian-speech-'));
  try {
    const source = join(directory, 'source');
    const target = join(directory, 'voice.ogg');
    await writeFile(source, Buffer.from(media.data, 'base64'), { mode: 0o600 });
    await promisify(execFile)(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        source,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'libopus',
        '-b:a',
        '48k',
        target,
      ],
      { signal, timeout: 30_000, maxBuffer: 4096 },
    );
    return {
      mimeType: 'audio/ogg',
      data: (await readFile(target)).toString('base64'),
      voice: true,
    };
  } catch {
    throw new Error('Speech could not be encoded as a voice note; ffmpeg must be installed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
