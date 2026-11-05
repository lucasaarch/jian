import { posix, win32 } from 'node:path';
import { REMOTE_FILES_MAX_TEXT, type RemoteFilesAnswer, type RemoteFilesOp } from '@jian/contracts';
import { z } from 'zod';
import type { Remote } from '../remote/service.js';
import {
  CHANGED,
  clip,
  type FileBackend,
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  READ_FIRST,
} from './files.js';
import type { GuardedSource } from './workspace.js';

/**
 * The file tools on the machine a conversation targets, through its worker's `files` tasks. The
 * worker reads, writes (compare and swap on the modification time), lists, finds and searches;
 * matching an edit, line endings, numbering and diffs stay with the shared tools in files.ts.
 *
 * Paths are the machine's, absolute in its own form (`/…`, or `C:\…` on Windows), and are shown as
 * the agent gave them: they mean nothing relative to the gateway's home. The worker refuses its
 * own folder (its credentials); everything else its user can reach is open, as on a desktop.
 */

/**
 * Whether a run offers the file tools on its machine: it targets one, that machine's worker last
 * said it runs file operations, and it is not a look back. What a run is told about files on a
 * machine (skills, context) is decided by this same answer.
 */
export async function offersMachineFiles(
  remote: Pick<Remote, 'offersFiles'> | undefined,
  run: { remoteTarget: string | null | undefined; learning: boolean },
): Promise<boolean> {
  if (!remote || !run.remoteTarget || run.learning) return false;
  return remote.offersFiles(run.remoteTarget);
}

/** Absolute on the machine, which may be Windows: `/…`, `C:\…` or `C:/…`. */
const machinePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => /^(?:\/|[A-Za-z]:[\\/])/.test(value), 'Use an absolute path');

const windowsShaped = (path: string) => /^[A-Za-z]:[\\/]/.test(path);

/**
 * One spelling of a machine path, for comparing two: `.` and `..` resolved, one kind of
 * separator, no trailing one, and folded where the machine's disk ignores case. Text only, since
 * the gateway cannot resolve a link on another machine: a link into a source is not caught here.
 */
function spelling(path: string, caseless: boolean) {
  const windows = windowsShaped(path);
  const normal = windows ? win32.normalize(path) : posix.normalize(path);
  const root = windows ? normal.slice(0, 3) : '/';
  const trimmed = normal.length > root.length ? normal.replace(/[\\/]+$/, '') : normal;
  return caseless || windows ? trimmed.toLowerCase() : trimmed;
}

/** Both in `spelling`'s form, so one separator kind each; a drive root already ends with it. */
const within = (path: string, root: string) => {
  const separator = root.includes('\\') ? '\\' : '/';
  return path === root || path.startsWith(root.endsWith(separator) ? root : root + separator);
};

type Ok<Name extends RemoteFilesOp['op']> = Extract<RemoteFilesAnswer, { ok: true; op: Name }>;
type Problem = Extract<RemoteFilesAnswer, { ok: false }>;

export type MachineFiles = {
  id: string;
  /** As the worker reports it, such as `darwin-arm64` or `win32-x64`. */
  platform: string;
};

/**
 * `guarded` gives the sources of the conversation's worktrees on this machine, read again before
 * each call (see `RunWorktrees`): a write into one is refused as on the gateway. Windows and macOS
 * compare paths without case (their default disks do); Linux compares them exactly.
 */
export function machineBackend(
  remote: Pick<Remote, 'executeFiles'>,
  profileId: string,
  machine: MachineFiles,
  guarded: () => readonly GuardedSource[] = () => [],
): FileBackend {
  const windows = machine.platform.startsWith('win32');
  const caseless = windows || machine.platform.startsWith('darwin');
  const partial = windows ? 'Get-Content with -TotalCount or -Tail' : 'head, tail or sed';
  // The worker refuses a file whose text exceeds what one answer carries, before offset and
  // limit apply (the worker never sees them): a longer file is read in parts by command.
  const readLimit = `On this machine a file of more than about ${REMOTE_FILES_MAX_TEXT.toLocaleString('en-US')} characters cannot be read at all; read part of a longer one with run_remote_command and ${partial}.`;

  /** What the machine refused, in the words the local tools use where they have some. */
  const refusal = (path: string, answer: Problem) => {
    switch (answer.problem) {
      case 'not-file':
        return new Error('That path is not a file');
      case 'binary':
        return new Error('The file is binary; inspect it with run_remote_command instead');
      case 'too-large':
        return new Error(
          `The file is too large for a read on a machine, which carries about ${REMOTE_FILES_MAX_TEXT.toLocaleString('en-US')} characters at most; read part of it with run_remote_command and ${partial}`,
        );
      case 'changed':
        return new Error(CHANGED);
      case 'exists':
        return new Error(READ_FIRST);
      case 'refused':
        return new Error(
          `${path} is Jian Remote's own data on that machine (its credentials), which the file tools do not open.`,
        );
      case 'missing':
        return new Error(`${path} does not exist on that machine`);
      case 'not-directory':
        return new Error(`${path} is not a folder`);
      default:
        return new Error(answer.message || `The machine could not do that (${answer.problem})`);
    }
  };

  const ask = async <Op extends RemoteFilesOp>(
    op: Op,
    signal: AbortSignal | undefined,
  ): Promise<Ok<Op['op']> | Problem> =>
    (await remote.executeFiles(profileId, machine.id, op, signal)) as Ok<Op['op']> | Problem;

  const done = <Name extends RemoteFilesOp['op']>(path: string, answer: Ok<Name> | Problem) => {
    if (!answer.ok) throw refusal(path, answer);
    return answer;
  };

  const readOp = (path: string) => ({ op: 'read' as const, path, maxBytes: MAX_FILE_BYTES });

  return {
    place: 'the machine this conversation works on',
    readLimit,
    // The worker falls back to its own walk without ripgrep, which reads every file.
    ignores: ' when ripgrep is installed there',
    path: machinePath,

    confine: async (path, access) => {
      // A `/…` path on Windows means the current drive's root, which the worker would resolve
      // somewhere the source guard never compares against.
      if (windows && !windowsShaped(path)) {
        throw new Error(
          `${path} has no drive letter; on this Windows machine use a full path such as C:\\Users\\…`,
        );
      }
      if (access === 'write') {
        const asked = spelling(path, caseless);
        const held = guarded().find(({ source }) => within(asked, spelling(source, caseless)));
        if (held) {
          // The gateway's words for the same refusal (workspace.ts), hint and all.
          throw Object.assign(
            new Error(
              `${path} is in ${held.source}, which this conversation works on in its worktree. Write in ${held.worktree} instead.`,
            ),
            { hint: `Write in ${held.worktree} instead.` },
          );
        }
      }
      return path;
    },

    shown: async (file) => file,

    read: async (file, signal) => {
      const { text, mtimeMs } = done(file, await ask(readOp(file), signal));
      return { text, mtimeMs };
    },

    current: async (file, seen, signal) => {
      // Nothing is asked of the machine for a file this run never read: it would be refused.
      if (seen === undefined) throw new Error(READ_FIRST);
      const { text, mtimeMs } = done(file, await ask(readOp(file), signal));
      if (mtimeMs !== seen) throw new Error(CHANGED);
      return text;
    },

    prior: async (file, seen, signal) => {
      // Unread, it must be new: the machine refuses the write if a file is there.
      if (seen === undefined) return { before: undefined, expected: null };
      const answer = await ask(readOp(file), signal);
      if (answer.ok) {
        if (answer.mtimeMs !== seen) throw new Error(CHANGED);
        return { before: answer.text, expected: seen };
      }
      // Gone since it was read: written anew, as the local tool does.
      if (answer.problem === 'missing') return { before: undefined, expected: null };
      // There but not text this can show: written over without a diff.
      if (answer.problem === 'binary' || answer.problem === 'too-large') {
        return { before: null, expected: seen };
      }
      throw refusal(file, answer);
    },

    write: async (file, content, expected, signal) => {
      if (content.length > REMOTE_FILES_MAX_TEXT) {
        throw new Error(
          `The file would have ${content.length} characters, more than the ${REMOTE_FILES_MAX_TEXT} a write on a machine carries; change it with run_remote_command`,
        );
      }
      const answer = await ask(
        { op: 'write', path: file, content, expectedMtimeMs: expected },
        signal,
      );
      return done(file, answer).mtimeMs;
    },

    list: async (directory, signal) => {
      const answer = done(
        directory,
        await ask({ op: 'list', path: directory, limit: MAX_ENTRIES }, signal),
      );
      return {
        path: directory,
        // As the local tool reports a link: neither a folder nor a file.
        entries: answer.entries.map(({ name, kind }) => ({
          name,
          kind: kind === 'symlink' ? 'other' : kind,
        })),
        truncated: answer.truncated,
      };
    },

    find: async (root, pattern, limit, signal) => {
      const answer = done(root, await ask({ op: 'find', path: root, pattern, limit }, signal));
      return { files: answer.files, ...(answer.truncated ? { truncated: true as const } : {}) };
    },

    search: async (target, input, signal) => {
      const answer = done(
        target,
        await ask(
          {
            op: 'search',
            path: target,
            pattern: input.pattern,
            ...(input.glob ? { glob: input.glob } : {}),
            ignoreCase: input.ignoreCase,
            contextLines: input.contextLines,
            output: input.output,
            limit: input.limit,
          },
          signal,
        ),
      );
      return {
        matches: clip(answer.matches.join('\n')),
        // The machine says only that it stopped early, not how much it left.
        ...(answer.truncated ? { truncated: 'more lines not shown' } : {}),
      };
    },
  };
}
