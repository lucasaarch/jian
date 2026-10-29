import type { Skill } from '@jian/contracts';

/** Offered only to a run the GitHub integration attached a server to: it teaches those tools. */
export const github: Skill = {
  name: 'github',
  description:
    'Use when a task involves GitHub — repositories, files, branches, issues, pull requests, reviews, Actions, releases or security alerts — through the account the owner connected under Integrations.',
  instructions: `# GitHub

The owner connected GitHub under Integrations, so Jian attaches GitHub's official MCP server to
this conversation, signed in as the Jian GitHub App. There is nothing to configure and no sign-in
to ask for.

## What you reach

- **In a project bound to a GitHub repository**: one server, \`github\`, limited to that
  repository.
- **Anywhere else**: one server per connected account — \`github\` when there is one,
  \`github_<login>\` when there are several — covering the repositories the owner granted the App
  on that account. Pick the server of the account that owns the repository.
- A 404 on a repository usually means the App was not granted it, not that it does not exist.
- You act as the App, not as the owner: what you write shows as the App's bot account.
- **Not reachable, by GitHub's design**: anything that belongs to a person rather than to a
  repository — their stars, their profile as "the authenticated user", their notifications.
  GitHub refuses an App's token there whatever its permissions, so those tools are left out.
  Say so plainly when asked, and offer the shell's \`gh\` if the profile is signed in there.

## Finding the tools

MCP tools are not loaded until you ask. Search with \`search_mcp_tools\` for what you need, then
load the ones you will call with \`load_mcp_tools\`. Searches that work:

| To | Search for |
|---|---|
| Read a file or a directory | "get file contents" |
| Search code, issues or pull requests | "search code", "search issues", "search pull requests" |
| Branch, commit, push files | "create branch", "create or update file", "push files" |
| Open, read, review, comment on a pull request | "create pull request", "pull request review" |
| Merge a pull request | "merge pull request" |
| Issues, labels, comments | "create issue", "update issue", "add issue comment", "labels" |
| Workflow runs, logs, re-runs | "list workflow runs", "get job logs", "rerun" |
| Code scanning, Dependabot, secret scanning alerts | "code scanning alerts", "dependabot", "secret scanning" |
| Releases, tags, commits | "list releases", "list tags", "get commit" |
| Discussions, security advisories | "discussions", "security advisories" |

## What it is not

- **Not a checkout.** For work on files with tests and builds, clone the repository in your
  workspace with the shell and work there; the App's token never reaches the shell, which uses
  the profile's SSH keys or its own \`gh\` sign-in. Use the server for what lives on GitHub:
  issues, reviews, pull requests, runs, alerts, and small file edits.
- **Not a wait.** To be told when checks finish or a pull request closes, use
  \`create_subscription\` instead of asking again and again.

## Acting

What you write is seen by everyone on the repository, and much of it cannot be taken back:
merging, closing, deleting a branch, publishing a release, re-running a deploy. Do those when
the owner asked for them. Work on a branch and open a pull request rather than pushing to the
default branch, unless told otherwise. Say what you did and link it.

## When a call fails

- **403 "Resource not accessible by integration"**: the App lacks that permission or that
  repository. Tell the owner to check the App's repository access on GitHub, or its
  permissions under Integrations.
- **404**: the repository is not granted, or the owner or name is wrong.
- **422 / Validation Failed**: a field is wrong; the \`github-mcp\` skill has the rules for issue
  and pull request fields.
- **The server is listed as unavailable** at the start of the turn: GitHub could not be reached
  this turn. Say so instead of guessing.
`,
};
