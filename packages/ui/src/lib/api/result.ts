/**
 * Turns a generated client call into its body, or into the sentence the owner should read. The
 * gateway answers in English; the panel is the only place that decides how a failure reads.
 */

/** The shapes the gateway uses for a failure body. Both fields are optional on purpose. */
type Detail = { error?: string; issues?: Array<{ path: string; message: string }> };

/** Conflicts the owner can act on. Anything else falls back to the generic 409 sentence. */
const conflicts: Record<string, string> = {
  'Wait for this conversation to finish before deleting it':
    'This chat is still running. Wait for it to finish, then delete it.',
  'Choose a default model before starting a run':
    'Choose a model under Model defaults before starting a conversation.',
  'This model does not accept the selected reasoning effort':
    'This model does not accept the selected reasoning effort.',
  'Reasoning effort is not catalogued for this model':
    'The reasoning levels of this model are not catalogued on this gateway.',
  'Choose a conversation with one project to read its changes.':
    'Choose a conversation with one project to read its changes.',
  'Changes on remote machines are not available here yet.':
    'Changes on remote machines are not available here yet.',
  'This conversation has no checkout yet.': 'This conversation has no checkout yet.',
  'This conversation has no git checkout at its project path.':
    'This conversation has no git checkout at its project path.',
  'Choose a worktree to read its changes.': 'Choose a worktree to read its changes.',
  'The agent is working in this conversation. Discard once it has finished.':
    'The agent is working here. Discard the worktree once the turn ends.',
  'The agent is answering this conversation. Ask again once it has finished.':
    'The agent is answering this conversation. Ask again once it has finished.',
  'This conversation no longer has a folder or a machine, so the agent has no worktree tools here. Give it a folder first.':
    'The agent has no folder or machine in this conversation, so it cannot work on a worktree. Give it a folder first.',
  'A pull request needs an origin on GitHub that the connected GitHub App reaches.':
    'A pull request needs an origin on GitHub that the connected GitHub App can reach.',
};

/** A worktree a subagent made its own from: the panel cannot reach the subagent's, the agent can. */
const madeFrom =
  /^([a-z]+-[a-z]+(?:-\d+)?) has a subagent's worktree made from it: merge or remove the subagent's worktree ([a-z]+-[a-z]+(?:-\d+)?) first\.$/;

function message(status: number, detail: Detail | undefined): string {
  if (status === 401) {
    return 'The token is invalid or expired. Sign in again.';
  }

  if (status === 403) {
    return 'This action needs the host token.';
  }

  // The server's own answer for a route it does not know, and never one of the gateway's sentences:
  // the panel is newer than the gateway it reaches, which is no fault of what was asked for.
  if (status === 404 && detail?.error === 'Not Found') {
    return 'This gateway does not have this yet. Update it to use it.';
  }

  if (status === 409) {
    const error = detail?.error ?? '';
    if (conflicts[error]) return conflicts[error];
    const blocked = madeFrom.exec(error);
    if (blocked) {
      return `A subagent's worktree, ${blocked[2]}, was made from ${blocked[1]}. Ask the agent to merge or remove it first.`;
    }
    if (error.startsWith('This model cannot run ')) {
      return `${error}. Clear or replace that activity's model, then try again.`;
    }
    if (error === 'Selected provider or model is unavailable') {
      return 'That provider or model is no longer available. Choose another under Model defaults.';
    }
    return 'Something changed, or the session is busy. Refresh and try again.';
  }

  if (status === 429) {
    return 'Rate limit reached. Wait a minute before trying again.';
  }

  // Each refused field with the reason, so a failure says what to fix and not only where.
  if (detail?.issues?.length) {
    const issues = detail.issues.map(({ path, message }) =>
      path ? `${path}: ${message}` : message,
    );
    return `${detail.error ?? 'Invalid request'}. ${issues.join('; ')}.`;
  }

  return detail?.error ?? `The request could not be completed (${status}).`;
}

/** The gateway answered, and the answer was a refusal or a failure. */
export class GatewayAnswer extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export async function result<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await request;

  // A 204 has no body by design, so its data is undefined on success; any other answer without
  // one is broken.
  const empty = response.status === 204;

  if (!response.ok || (data === undefined && !empty)) {
    throw new GatewayAnswer(message(response.status, error as Detail | undefined), response.status);
  }

  return data as T;
}
