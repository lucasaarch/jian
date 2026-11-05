import type { RemoteFilesAnswer, RemoteFilesOp, RemoteResult, RemoteTask } from '@jian/contracts';
import { RESULT_BYTES } from './limits.ts';
import { isRefused, REFUSED_MESSAGE, realLocation, refusedFolders } from './paths.ts';
import { findFiles, listFolder, SEARCH_TIMEOUT_MS, searchFiles, shower } from './search.ts';
import { FilesProblem, problemOf, readBytes, readText, writeBytes, writeText } from './text.ts';
import { parseFilesOp } from './validate.ts';

export { refusedFolders, setRefusedFolders } from './paths.ts';

export type FilesOptions = {
  /** Folders that are off limits, real or not; defaults to this worker's config folder. */
  refused?: string[];
  /** The environment a search program is found in. */
  env?: NodeJS.ProcessEnv;
  /** How long a search may run, in ms; the task's own limit when it is shorter than 30 s. */
  timeoutMs?: number;
};

const OPS = [
  'read',
  'write',
  'list',
  'find',
  'search',
  'read-bytes',
  'write-bytes',
  'git-status',
  'git-file',
  'merge-base',
] as const;

type Op = (typeof OPS)[number];

const fail = (
  op: Op,
  problem: Extract<RemoteFilesAnswer, { ok: false }>['problem'],
  message: string,
): RemoteFilesAnswer => ({ ok: false, op, problem, message: message.slice(0, 2000) });

/** The op the request named, for an answer to a request that did not parse. */
const nameOf = (value: unknown): Op => {
  const op = (value as { op?: unknown } | undefined)?.op;
  return OPS.find((name) => name === op) ?? 'read';
};

async function run(op: RemoteFilesOp, options: FilesOptions): Promise<RemoteFilesAnswer> {
  if (op.op === 'git-status' || op.op === 'git-file' || op.op === 'merge-base') {
    return fail(op.op, 'failed', 'Not available yet.');
  }
  const refused = options.refused ?? refusedFolders();
  const real = await realLocation(op.path);
  if (await isRefused(real, refused)) return fail(op.op, 'refused', REFUSED_MESSAGE);
  // Everything acts on the real path the checks saw, never on the spelling given: `..` after a
  // link, `./`, case and a link as the root all lead where the real path leads. Answers that
  // name paths show them as the agent gave them.
  switch (op.op) {
    case 'read':
      return readText(real, op);
    case 'read-bytes':
      return readBytes(real, op);
    case 'write':
      return writeText(real, op);
    case 'write-bytes':
      return writeBytes(real, op);
    case 'list':
      return listFolder(real, op);
    case 'find':
      return findFiles(real, op, refused, shower(op.path, real));
    case 'search':
      return searchFiles(
        real,
        op,
        options.env ?? process.env,
        refused,
        shower(op.path, real),
        options.timeoutMs,
      );
  }
}

/** Runs one file operation on this machine. No shell; the answer carries no more than the contract. */
export async function answerFilesOp(
  request: unknown,
  options: FilesOptions = {},
): Promise<RemoteFilesAnswer> {
  const parsed = parseFilesOp(request);
  if (!parsed) return fail(nameOf(request), 'failed', 'That file operation is not valid.');
  let answer: RemoteFilesAnswer;
  try {
    answer = await run(parsed, options);
  } catch (error) {
    const problem = problemOf(error);
    answer = fail(parsed.op, problem.problem, problem.message);
  }
  // Characters are not bytes: the whole answer is measured as it will travel.
  const bytes = Buffer.byteLength(JSON.stringify(answer));
  if (bytes > RESULT_BYTES) {
    return fail(
      parsed.op,
      'too-large',
      `The answer would be ${bytes} bytes, more than a result can carry.`,
    );
  }
  return answer;
}

/** Runs a `files` task and wraps its answer as the result the gateway expects. */
export async function executeFilesTask(
  task: RemoteTask,
  options: FilesOptions = {},
): Promise<RemoteResult> {
  const files = await answerFilesOp(task.files, {
    ...options,
    timeoutMs: options.timeoutMs ?? Math.min(SEARCH_TIMEOUT_MS, Math.max(1, task.timeoutMs)),
  });
  return {
    taskId: task.id,
    exitCode: files.ok ? 0 : 1,
    stdout: '',
    stderr: '',
    timedOut: false,
    files,
  };
}

export { FilesProblem };
