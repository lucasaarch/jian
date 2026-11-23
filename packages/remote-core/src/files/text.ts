import { randomBytes } from 'node:crypto';
import { chmod, constants, mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RemoteFilesAnswer, RemoteFilesOp } from '@jian/contracts';
import { MAX_TEXT } from './limits.ts';

type Op<Name extends RemoteFilesOp['op']> = Extract<RemoteFilesOp, { op: Name }>;
type Failure = Extract<RemoteFilesAnswer, { ok: false }>;

/** A refusal in the contract's words, thrown from deep helpers and answered at the top. */
export class FilesProblem extends Error {
  readonly problem: Failure['problem'];
  constructor(problem: Failure['problem'], message: string) {
    super(message);
    this.problem = problem;
  }
}

/** The largest raw file whose base64 fits a write's or a read's text limit. */
const MAX_RAW_BYTES = Math.floor((MAX_TEXT / 4) * 3);
/** What a read asks for at a time when the file does not say its size, in bytes. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Maps what `fs` throws to what the agent can act on. */
export function problemOf(error: unknown): FilesProblem {
  if (error instanceof FilesProblem) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new FilesProblem('missing', 'That path does not exist.');
  if (code === 'ENOTDIR')
    return new FilesProblem('not-directory', 'A part of that path is not a folder.');
  if (code === 'EISDIR') return new FilesProblem('not-file', 'That path is not a file.');
  const reason = code ?? (error instanceof Error ? error.message : 'unknown error');
  return new FilesProblem('failed', `The operation failed (${reason}).`);
}

/** The file at a real path, which must be a regular file no larger than `maxBytes`. */
async function regularFile(real: string, maxBytes: number) {
  const info = await stat(real);
  if (!info.isFile()) throw new FilesProblem('not-file', 'That path is not a file.');
  if (info.size > maxBytes) {
    throw new FilesProblem(
      'too-large',
      `The file has ${info.size} bytes, more than the ${maxBytes} this read allows.`,
    );
  }
  return info;
}

/**
 * A regular file, never read past `maxBytes`. The size `stat` gave is no limit: a file under
 * /proc says 0 and can yield gigabytes. O_NONBLOCK keeps a kernel file with nothing to say yet,
 * like /proc/kmsg, from holding a worker that runs one task at a time; it does nothing to a file
 * on disk, and Windows has no such flag.
 */
async function readWithin(real: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FilesProblem('not-file', 'That path is not a file.');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const wanted = Math.max(READ_CHUNK_BYTES, info.size + 1 - total);
      const chunk = Buffer.allocUnsafe(Math.min(maxBytes + 1 - total, wanted));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) {
        throw new FilesProblem(
          'too-large',
          `The file has more than the ${maxBytes} bytes this read allows.`,
        );
      }
    }
  } finally {
    await handle.close();
  }
}

export async function readText(real: string, op: Op<'read'>): Promise<RemoteFilesAnswer> {
  const info = await regularFile(real, op.maxBytes);
  const buffer = await readWithin(real, op.maxBytes);
  if (buffer.subarray(0, 8000).includes(0)) {
    throw new FilesProblem('binary', 'The file is binary.');
  }
  const text = buffer.toString('utf8');
  if (text.length > MAX_TEXT) {
    throw new FilesProblem(
      'too-large',
      `The file has ${buffer.length} bytes, more than a result can carry.`,
    );
  }
  return { ok: true, op: 'read', text, mtimeMs: info.mtimeMs, bytes: buffer.length };
}

export async function readBytes(real: string, op: Op<'read-bytes'>): Promise<RemoteFilesAnswer> {
  const info = await regularFile(real, op.maxBytes);
  if (info.size > MAX_RAW_BYTES) {
    throw new FilesProblem(
      'too-large',
      `The file has ${info.size} bytes, more than a result can carry.`,
    );
  }
  const buffer = await readWithin(real, Math.min(op.maxBytes, MAX_RAW_BYTES));
  return { ok: true, op: 'read-bytes', base64: buffer.toString('base64'), bytes: buffer.length };
}

/** The `fs` calls a write makes that can fail half way; a test replaces one to prove the rest. */
export type WriteIo = { rename: typeof rename };

/**
 * Replaces a file all at once: the data goes to a temp file in the same folder, so the rename
 * is atomic on one filesystem and a reader sees the old file or the new, never half. The mode of
 * the file being replaced is kept. A failure leaves no temp file behind.
 */
export async function writeAtomic(
  target: string,
  data: string | Buffer,
  mode: number | undefined,
  io: WriteIo = { rename },
): Promise<void> {
  // Not named after the target: a name near the 255 byte limit would leave no room for a suffix.
  const temp = join(dirname(target), `.jian-write-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, data, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    // `mode` passes through the umask on creation; the replaced file's own bits are kept exactly.
    if (mode !== undefined) await chmod(temp, mode);
    await io.rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** What is at `real` now, or undefined when nothing is. A folder is refused here. */
async function current(real: string) {
  const info = await stat(real).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (info && !info.isFile()) throw new FilesProblem('not-file', 'That path is not a file.');
  return info;
}

export async function writeText(real: string, op: Op<'write'>): Promise<RemoteFilesAnswer> {
  const before = await current(real);
  if (op.expectedMtimeMs === null && before) {
    throw new FilesProblem('exists', 'The file already exists; read it before changing it.');
  }
  if (op.expectedMtimeMs !== null && before?.mtimeMs !== op.expectedMtimeMs) {
    throw new FilesProblem(
      'changed',
      before ? 'The file changed since it was read.' : 'The file no longer exists.',
    );
  }
  await mkdir(dirname(real), { recursive: true });
  await writeAtomic(real, op.content, before ? before.mode & 0o7777 : undefined);
  const after = await stat(real);
  return {
    ok: true,
    op: 'write',
    mtimeMs: after.mtimeMs,
    bytes: Buffer.byteLength(op.content),
    created: !before,
  };
}

export async function writeBytes(real: string, op: Op<'write-bytes'>): Promise<RemoteFilesAnswer> {
  const before = await current(real);
  const data = Buffer.from(op.base64, 'base64');
  await mkdir(dirname(real), { recursive: true });
  await writeAtomic(real, data, before ? before.mode & 0o7777 : undefined);
  return { ok: true, op: 'write-bytes', bytes: data.length };
}
