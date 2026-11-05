import {
  REMOTE_FILES_MAX_GIT_SIDE,
  type RemoteFilesAnswer,
  type RemoteFilesOp,
  remoteFilesOpSchema,
  type Session,
  type SessionChange,
} from '@jian/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { GatewayError } from '../core/errors.js';
import type { Queryable } from '../storage/database.js';
import { projects } from '../storage/schema.js';
import { repositoryName } from '../worktrees/repository.js';
import type { CheckoutReader, FileSides } from './changes.js';
import { listLoads } from './loads.js';

/** One file operation on the conversation's machine, as `Remote.executeFiles` runs it. */
export type AskMachine = (op: RemoteFilesOp) => Promise<RemoteFilesAnswer>;

type Answer<Name extends RemoteFilesOp['op']> = Extract<RemoteFilesAnswer, { ok: true; op: Name }>;
type Refusal = Extract<RemoteFilesAnswer, { ok: false }>;

/** A refusal about the checkout itself, worded as the gateway's own checkout would be. */
function checkoutRefusal(answer: Refusal): GatewayError {
  switch (answer.problem) {
    case 'missing':
    case 'not-directory':
      return new GatewayError(409, 'This conversation has no checkout yet.');
    case 'not-repository':
      return new GatewayError(409, 'This conversation has no git checkout at its project path.');
    case 'too-large':
      return new GatewayError(
        413,
        'The checkout is too large or slow to display. Use git in the terminal.',
      );
    case 'refused':
      return new GatewayError(409, 'Jian Remote on that machine does not read this folder.');
    default:
      return new GatewayError(409, 'The checkout changes could not be read.');
  }
}

/** Why one file has no text diff, from the machine's refusal. */
function fileRefusal(answer: Refusal): FileSides {
  switch (answer.problem) {
    case 'missing':
    case 'not-repository':
      throw checkoutRefusal(answer);
    case 'too-large':
      return { unavailable: 'The file is too large to display.' };
    case 'binary':
      return { unavailable: 'Binary files have no text diff.' };
    case 'not-file':
      return { unavailable: 'Symlinks and submodules have no text diff.' };
    case 'refused':
      return { unavailable: 'The file resolves outside this checkout.' };
    default:
      return { unavailable: 'The file could not be read on the machine.' };
  }
}

const mismatch = () => new GatewayError(502, 'The machine answered something else.');

/**
 * A checkout on a machine, read through its worker's git operations, which run git with the
 * settings of `openCheckout`. Each side of a file comes back whole up to the 200,000 bytes one
 * worker result can carry for both; a larger one is shown as too large to display.
 */
export function machineReader(root: string, ask: AskMachine): CheckoutReader {
  const side = async (path: string, against: string) => {
    const op = { op: 'git-file', root, path, against, maxBytes: REMOTE_FILES_MAX_GIT_SIDE };
    // A changed path the contract refuses (one starting with `-`) is not sent at all.
    const checked = remoteFilesOpSchema.safeParse(op);
    if (!checked.success) return { unavailable: 'This file cannot be read on the machine.' };
    const answer = await ask(checked.data);
    if (answer.op !== 'git-file') throw mismatch();
    if (!answer.ok) return fileRefusal(answer);
    if (answer.binary) return { unavailable: 'Binary files have no text diff.' };
    return answer as Answer<'git-file'>;
  };

  return {
    async status(against) {
      const answer = await ask({ op: 'git-status', root, ...(against ? { against } : {}) });
      if (answer.op !== 'git-status') throw mismatch();
      if (!answer.ok) throw checkoutRefusal(answer);
      if (against && answer.diff === undefined) throw mismatch();
      return { status: answer.status, ...(against ? { diff: answer.diff } : {}) };
    },

    async file(file: SessionChange, against: string): Promise<FileSides> {
      const wantsAfter = file.status !== 'deleted';
      const wantsBefore = file.status !== 'untracked' && file.status !== 'added';
      // A renamed or copied file's committed side is under its old path, its current one under
      // the new: the two are separate reads, as `git show` of the old path is locally.
      const current = await side(file.path, against);
      if ('unavailable' in current) return current;
      const original =
        wantsBefore && file.previousPath ? await side(file.previousPath, against) : current;
      if ('unavailable' in original) return original;
      if (wantsAfter && current.after === null) {
        return { unavailable: 'The file changed while reading; refresh the changes.' };
      }
      if (wantsBefore && original.before === null) {
        return { unavailable: 'The committed version could not be read.' };
      }
      return {
        after: wantsAfter ? (current.after ?? '') : '',
        ...(wantsBefore ? { before: original.before ?? '' } : {}),
      };
    },

    async mergeBase(base) {
      const answer = await ask({ op: 'merge-base', root, base });
      if (answer.op !== 'merge-base') throw mismatch();
      if (answer.ok) return answer.sha;
      if (answer.problem === 'missing' || answer.problem === 'not-repository') {
        throw checkoutRefusal(answer);
      }
      throw new GatewayError(409, `Could not find where this worktree left ${base}.`);
    },
  };
}

/** How long a machine's answer about a checkout is shown again, in ms: the panel's poll. */
const MACHINE_ANSWER_MS = 10_000;

type Kept = { at: number; runs: string; answer: Promise<RemoteFilesAnswer> };

/**
 * What machines answered about checkouts, so the panel reading every 10 seconds does not hand
 * the machine a task each time. An answer is kept per profile, conversation, machine and the
 * operation itself (root, comparison base and path), never shared between conversations or
 * profiles, and is not served once one of the conversation's runs has ended since it was
 * asked: a turn that ended may have changed the checkout. A read still under way is shared, so
 * the list and an open file polled together send it once.
 */
export class MachineAnswers {
  private readonly kept = new Map<string, Kept>();

  constructor(private readonly now: () => number) {}

  answer(
    scope: { profileId: string; sessionId: string; machineId: string; runs: string },
    op: RemoteFilesOp,
    ask: () => Promise<RemoteFilesAnswer>,
  ): Promise<RemoteFilesAnswer> {
    const now = this.now();
    for (const [key, entry] of this.kept) {
      if (now - entry.at >= MACHINE_ANSWER_MS) this.kept.delete(key);
    }
    const key = JSON.stringify([scope.profileId, scope.sessionId, scope.machineId, op]);
    const found = this.kept.get(key);
    if (found && found.runs === scope.runs) return found.answer;

    const entry: Kept = { at: now, runs: scope.runs, answer: ask() };
    this.kept.set(key, entry);
    // An offline machine or a timeout is not an answer: the next poll asks again.
    entry.answer.catch(() => {
      if (this.kept.get(key) === entry) this.kept.delete(key);
    });
    return entry.answer;
  }
}

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;
const lastPart = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1);

/**
 * The one checkout of the conversation's projects known on its machine: `<cloneInto>/<name>`
 * when the owner chose where it clones, else a clone `github_git` recorded there under the
 * project's repository name. A clone by a relative path is under the worker's home, which the
 * gateway does not know. Undefined when none is known; several are a choice the gateway does
 * not make for the owner.
 */
export async function cloneOnMachine(
  db: Queryable,
  profileId: string,
  session: Pick<Session, 'id' | 'projectId' | 'projectIds' | 'cloneInto' | 'remoteMachineId'>,
): Promise<string | undefined> {
  const machineId = session.remoteMachineId;
  const ids = [
    ...new Set([...(session.projectId ? [session.projectId] : []), ...(session.projectIds ?? [])]),
  ];
  if (!machineId || ids.length === 0) return undefined;
  const rows = await db
    .select({ url: projects.repositoryUrl })
    .from(projects)
    .where(and(eq(projects.profileId, profileId), inArray(projects.id, ids)));
  const names = new Set(rows.map((row) => repositoryName(row.url ?? '')).filter(Boolean));
  let known: string[];
  if (session.cloneInto) {
    known = [...names].map((name) => `${session.cloneInto}/${name}`);
  } else {
    known = (await listLoads(db, profileId, session.id))
      .filter((load) => load.kind === 'workspace' && load.name.startsWith(`${machineId}|`))
      .map((load) => load.name.slice(machineId.length + 1))
      .filter((path) => ABSOLUTE.test(path) && names.has(lastPart(path)));
  }
  const unique = [...new Set(known)];
  if (unique.length > 1) {
    throw new GatewayError(409, 'Choose a conversation with one project to read its changes.');
  }
  return unique[0];
}
