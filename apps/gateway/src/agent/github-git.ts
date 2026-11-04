import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { GitHubIntegrations } from '../integrations/github.js';
import {
  branchName,
  checkoutPath,
  credentialConfig,
  type GitAction,
  gitArguments,
  gitProblem,
  namesRepository,
  ORIGIN_QUERY,
  originUrls,
  repositoryName,
  tagName,
} from './github-git-command.js';
import type { GitPlace } from './github-git-place.js';

const GITHUB_GIT = 'github_git';

const input = z.object({
  action: z.enum(['clone', 'fetch', 'pull', 'push']),
  repository: repositoryName.describe('owner/name of the GitHub repository.'),
  path: checkoutPath
    .optional()
    .describe(
      "The checkout. Default: this conversation's checkout in a project, otherwise a folder named after the repository where this gateway keeps clones (on a machine, in its home). The result names the path.",
    ),
  branch: branchName
    .optional()
    .describe(
      'clone: the branch to check out. fetch, pull: that branch only. push: the branch, or give tag instead.',
    ),
  tag: tagName
    .optional()
    .describe(
      'push only, instead of branch: a tag the checkout has, such as a release tag. A tag GitHub already has is never moved.',
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe('clone only: a shallow clone with this many commits.'),
  rebase: z.boolean().optional().describe('pull only: rebase instead of fast-forward only.'),
  force: z
    .boolean()
    .optional()
    .describe(
      'push of a branch only: overwrite the remote branch, with a lease. Only when the owner asked.',
    ),
});

type Call = z.infer<typeof input>;

/** The one git command a call stands for; options the action does not take are left out. */
function commandOf(call: Call, path: string, url: string): GitAction {
  const branch = call.branch ? { branch: call.branch } : {};

  switch (call.action) {
    case 'clone':
      return {
        action: 'clone',
        url,
        path,
        ...branch,
        ...(call.depth ? { depth: call.depth } : {}),
      };
    case 'fetch':
      return { action: 'fetch', path, ...branch };
    case 'pull':
      return { action: 'pull', path, ...branch, rebase: call.rebase === true };
    case 'push':
      if (call.tag) return { action: 'push-tag', path, tag: call.tag };
      if (!call.branch) throw new GatewayError(400, 'Name the branch or the tag to push.');
      return { action: 'push', path, branch: call.branch, force: call.force === true };
  }
}

/** Why a push cannot be run as asked; undefined when it can. */
function pushRefusal(call: Call): string | undefined {
  if (call.action !== 'push') return undefined;
  if (call.branch && call.tag) return 'Push a branch or a tag, not both.';
  if (!call.branch && !call.tag) return 'Name the branch or the tag to push.';
  // A release workflow runs on the tag; moving one would publish a version under another's name.
  if (call.tag && call.force) return 'A tag is never force-pushed: a published tag never moves.';
  return undefined;
}

/** The checkout's origin must be the repository the call names, or nothing is lent. */
async function checkedOrigin(place: GitPlace, path: string, repository: string, url: string) {
  const read = await place.git(['-C', path, ...ORIGIN_QUERY]);
  const urls = originUrls(read.stdout);

  if (read.exitCode !== 0 && !urls.length) {
    throw new GatewayError(
      400,
      /not a git repository|cannot change to/i.test(read.stderr)
        ? `There is no git checkout at ${path}. Clone ${repository} first.`
        : `The checkout at ${path} has no origin remote. Set origin to ${url} with git first.`,
    );
  }
  const elsewhere = urls.filter((item) => !namesRepository(item, repository, url));
  if (elsewhere.length) {
    throw new GatewayError(
      400,
      `The origin of ${path} is ${elsewhere.join(', ')}, not ${repository}. Name the repository this checkout comes from.`,
    );
  }
  return urls;
}

/**
 * Clone, fetch, pull and push of GitHub repositories with the Jian GitHub App's token, where the
 * conversation works. One tool for the four: the reach, the credential and the checks are the
 * same, and only the action decides whether it changes the machine or GitHub (see guard.ts).
 *
 * The token is minted for the one repository, lent to the one git process through its
 * environment, and masked wherever the run records what happened (`lend`). It never lands in
 * a file, a URL or a command line. Everything else git does stays with raw `git` in the shell.
 */
export function githubGitTools(options: {
  github: Pick<GitHubIntegrations, 'gitAccess'>;
  profileId: string;
  projectId?: string | null;
  /** Where a project conversation keeps its checkout, on the gateway. */
  projectCheckout?: string;
  /** Where this conversation clones each of its repositories, when it says so. */
  checkoutOf?: (name: string) => string;
  place: GitPlace;
  lend: (secret: string) => void;
  /**
   * Told the head a push left the branch at, so the gateway's watch over a pull request of it
   * does not take the agent's own commits for someone else's.
   */
  pushed?: (repository: string, branch: string, sha: string) => Promise<void> | undefined;
  /** Told where a clone landed: a folder the conversation works in from now on. */
  cloned?: (path: string) => Promise<void> | undefined;
}): ToolSet {
  const { github, place, lend } = options;

  return {
    [GITHUB_GIT]: tool({
      description:
        'Clone, fetch, pull or push a GitHub repository with the access of the GitHub App the owner connected, where this conversation works: the machine this gateway runs on, or the machine it targets. Use it for every GitHub clone, fetch, pull and push, also when origin is an SSH URL; use git in the shell for everything local (status, branch, commit, tag, diff, merge). Push needs branch, or tag to push a tag.',
      inputSchema: input,
      execute: async (call, { abortSignal }) => {
        // Before any token is minted for it.
        const refused = pushRefusal(call);
        if (refused) throw new GatewayError(400, refused);
        const access = await github.gitAccess(
          options.profileId,
          options.projectId,
          call.repository,
        );
        lend(access.token);

        const clone = call.action === 'clone';
        const name = access.repository.split('/')[1] ?? 'checkout';
        const fallback = options.checkoutOf?.(name) ?? options.projectCheckout ?? name;
        const path = await place.checkout(call.path, fallback, clone);
        const urls = clone ? [] : await checkedOrigin(place, path, access.repository, access.url);
        const credential = credentialConfig({ token: access.token, httpsUrl: access.url, urls });
        lend(credential.encoded);

        const command = commandOf(call, path, access.url);
        const outcome = await place.git(gitArguments(command), credential.entries, abortSignal);
        const output = `${outcome.stdout}\n${outcome.stderr}`.trim();
        const done = outcome.exitCode === 0 && !outcome.timedOut;

        if (done && command.action === 'clone') {
          await Promise.resolve(options.cloned?.(path)).catch(() => undefined);
        }
        if (done && command.action === 'push' && options.pushed) {
          await ownHead(place, path, command.branch, abortSignal)
            .then((sha) =>
              sha ? options.pushed?.(access.repository, command.branch, sha) : undefined,
            )
            .catch(() => undefined);
        }

        return {
          ok: done,
          action: call.action,
          repository: access.repository,
          path,
          where: place.name,
          ...(done
            ? { output }
            : {
                problem: outcome.timedOut
                  ? 'git did not finish in time. For a large repository, clone with depth.'
                  : (gitProblem(outcome.stderr, access.repository) ??
                    'git failed; its output follows.'),
                exitCode: outcome.exitCode,
                output,
              }),
        };
      },
    }),
  };
}

/** The commit a pushed branch points at, read back from the checkout that pushed it. */
async function ownHead(
  place: GitPlace,
  path: string,
  branch: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const outcome = await place.git(['-C', path, 'rev-parse', `refs/heads/${branch}`], [], signal);
  const sha = outcome.stdout.trim();
  return outcome.exitCode === 0 && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
}
