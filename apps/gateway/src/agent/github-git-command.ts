import { z } from 'zod';

/**
 * What `github_git` hands git, built from checked input alone. Nothing the agent types reaches
 * git as an option: no `-c`, no `--upload-pack`, no URL of its choosing. The repository is a
 * GitHub name, the URL is the integration's, and every name that ends up as an argument is
 * refused when it could be read as an option.
 */

export const repositoryName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, 'Use owner/name, as GitHub shows it')
  .refine((value) => !/\/\.{1,2}$/.test(value), 'Use owner/name, as GitHub shows it');

/** A branch as git's ref rules allow it, never starting with `-`. */
export const branchName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/+-]+(?<![/.])$/, {
    message: 'Not a branch name git accepts',
  });

/** A checkout path; quotes and control characters are refused so no shell can misread it. */
export const checkoutPath = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !/["\p{Cc}]/u.test(value) && !value.startsWith('-'), {
    message: 'Use a plain path, without quotes or control characters',
  });

export type GitAction =
  | { action: 'clone'; url: string; path: string; branch?: string; depth?: number }
  | { action: 'fetch'; path: string; branch?: string }
  | { action: 'pull'; path: string; branch?: string; rebase?: boolean }
  | { action: 'push'; path: string; branch: string; force?: boolean };

/** The arguments of one git command; a checkout is named with `-C`, so a missing one fails. */
export function gitArguments(command: GitAction): string[] {
  switch (command.action) {
    case 'clone':
      return [
        'clone',
        ...(command.branch ? ['--branch', command.branch] : []),
        ...(command.depth ? ['--depth', String(command.depth)] : []),
        '--',
        command.url,
        command.path,
      ];
    case 'fetch':
      return [
        '-C',
        command.path,
        'fetch',
        // Submodules live elsewhere; the credential is for this repository alone.
        '--no-recurse-submodules',
        'origin',
        ...(command.branch ? [command.branch] : []),
      ];
    case 'pull':
      return [
        '-C',
        command.path,
        'pull',
        '--no-recurse-submodules',
        command.rebase ? '--rebase' : '--ff-only',
        'origin',
        ...(command.branch ? [command.branch] : []),
      ];
    case 'push':
      return [
        '-C',
        command.path,
        'push',
        // A lease, not a blind force: it refuses when the branch moved since it was last fetched.
        ...(command.force ? ['--force-with-lease'] : []),
        '--set-upstream',
        'origin',
        `refs/heads/${command.branch}:refs/heads/${command.branch}`,
      ];
  }
}

/** Reads the raw URLs of origin, before any `insteadOf` of the machine rewrites them. */
export const ORIGIN_QUERY = ['config', '--get-regexp', '^remote\\.origin\\.(url|pushurl)$'];

export function originUrls(output: string): string[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => /^remote\.origin\.(?:url|pushurl)\s+(.+)$/.exec(line.trim())?.[1]?.trim())
        .filter((url): url is string => Boolean(url)),
    ),
  ];
}

/**
 * Whether a remote URL names the repository: over HTTPS at the integration's origin, or over
 * SSH at github.com, with or without `.git`. Case does not matter to GitHub, so not here.
 */
export function namesRepository(url: string, repository: string, httpsUrl: string): boolean {
  const name = repository.toLowerCase();
  const https = httpsUrl.replace(/\.git$/, '').toLowerCase();
  const plain = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();

  return (
    plain === https ||
    plain === `https://github.com/${name}` ||
    plain === `git@github.com:${name}` ||
    plain === `ssh://git@github.com/${name}` ||
    plain === `ssh://git@github.com:22/${name}`
  );
}

/**
 * The configuration one git command runs with, as `GIT_CONFIG_*` variables, so nothing is
 * written to `.git/config` or the remote URL and the credential ends with the process.
 *
 * - The token goes as a Basic header to the integration's origin only.
 * - Credential helpers are cleared, so a login stored on the machine is not tried instead.
 * - Each URL of origin, SSH ones included, is rewritten to the HTTPS URL for this command. A
 *   rewrite whose prefix is the whole URL is the longest there can be, so it wins over any
 *   `insteadOf` of the machine's own, such as one that sends github.com to SSH.
 */
export function credentialConfig(input: {
  token: string;
  httpsUrl: string;
  /** The URLs the command will reach the repository by, as configured. */
  urls: readonly string[];
}): { entries: Array<[string, string]>; encoded: string } {
  const origin = new URL(input.httpsUrl).origin;
  // Encoded, the token no longer looks like itself: the caller masks this form as well.
  const encoded = Buffer.from(`x-access-token:${input.token}`).toString('base64');
  const header = `AUTHORIZATION: basic ${encoded}`;
  const rewrites = [...new Set([input.httpsUrl, ...input.urls])].flatMap(
    (url): Array<[string, string]> => [
      [`url.${input.httpsUrl}.insteadOf`, url],
      [`url.${input.httpsUrl}.pushInsteadOf`, url],
    ],
  );

  return {
    encoded,
    entries: [[`http.${origin}/.extraheader`, header], ['credential.helper', ''], ...rewrites],
  };
}

/** Appends entries to an environment's `GIT_CONFIG_*`, after any it already carries. */
export function withGitConfig(
  env: NodeJS.ProcessEnv,
  entries: ReadonlyArray<[string, string]>,
): NodeJS.ProcessEnv {
  const start = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  const added: NodeJS.ProcessEnv = {};

  entries.forEach(([key, value], index) => {
    added[`GIT_CONFIG_KEY_${start + index}`] = key;
    added[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });

  return {
    ...env,
    ...added,
    GIT_CONFIG_COUNT: String(start + entries.length),
    // A refused token fails at once instead of waiting on a prompt nobody can answer.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };
}

/** What a failed git command means, in words the agent can act on; undefined when unknown. */
export function gitProblem(stderr: string, repository: string): string | undefined {
  const text = stderr.toLowerCase();

  if (/repository not found|not found\b.*\b404|\b404\b/.test(text)) {
    return `GitHub says ${repository} is not found to the Jian GitHub App. The owner can grant the App access to it on GitHub.`;
  }
  if (
    /authentication failed|could not read username|terminal prompts disabled|invalid username or (?:password|token)|\b401\b/.test(
      text,
    )
  ) {
    return `GitHub refused the App's token for ${repository}. Try once more; if it is refused again, the owner should check the App's installation and permissions under Integrations → GitHub.`;
  }
  if (/gh006|protected branch/.test(text)) {
    return 'GitHub refused the push: the branch is protected. Push another branch and open a pull request.';
  }
  if (/stale info/.test(text)) {
    return 'The forced push was refused: the remote branch moved since it was last fetched. Fetch, look at what changed, and decide again.';
  }
  if (/\[rejected\]|non-fast-forward|fetch first/.test(text)) {
    return 'The push was rejected as non-fast-forward: the remote branch has commits this one does not. Pull (with rebase: true to keep history linear), resolve any conflict, and push again. Force only when the owner asked for it.';
  }
  if (/not possible to fast-forward|diverging branches|have diverged/.test(text)) {
    return 'The pull stopped: the local and remote branches have diverged. Pull again with rebase: true, or merge with git yourself.';
  }
  if (/\b403\b|permission to .* denied|write access .* not granted/.test(text)) {
    return `GitHub refused the App's access to ${repository} for this. The owner can check the App's repository access and permissions on GitHub.`;
  }
  if (/already exists and is not an empty directory/.test(text)) {
    return 'The path already exists and is not empty. Pick another path, or fetch or pull in the checkout that is there.';
  }
  if (/cannot change to|not a git repository/.test(text)) {
    return 'There is no git checkout at that path. Clone it first.';
  }
  return undefined;
}
