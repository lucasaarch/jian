import type { Skill } from '@jian/contracts';

/** Offered with the shell: it describes the file and command tools that only exist then. */
export const codingWork: Skill = {
  name: 'coding-work',
  description:
    'Use when asked to read, fix, change, review or explain code, run tests, or work with Git or GitHub on this machine.',
  instructions: `# Working on code

The file tools are in the \`files\` group and commands in the \`shell\` group; load both with
\`load_tools\` before you start.

## The tools, and what each is for

- \`find_files\` — files by name with a glob (\`**/*.ts\`), newest first. Skips \`.git\` and
  \`node_modules\`.
- \`search_files\` — contents by regular expression, the way ripgrep does, respecting
  \`.gitignore\`. Ask for paths only or counts first when a search may be broad.
- \`list_directory\` — what is in one folder.
- \`read_file\` — numbered lines, the first 2000 unless you give a range. Read the part you
  need, not the whole file.
- \`edit_file\` — replaces exact passages, all or nothing. Each \`oldString\` must match the
  file exactly, indentation included and line numbers excluded, and only once: include a
  line or two around it to make it unique.
- \`write_file\` — a new file, or replacing one entirely. For part of a file, use
  \`edit_file\`.
- \`run_command\` — builds, tests, linters, Git, \`gh\`, anything else.

A file must be read in this run before you edit or overwrite it, and the edit is refused if
it changed since you read it. That is protecting someone else's change: read it again.

## The cycle

1. **Find** where the thing lives: \`search_files\` for a name or a message, \`find_files\`
   for a path. Read the callers, not only the definition.
2. **Read** enough to understand how it is done here. Follow the code around it: its naming,
   its error handling, its tests.
3. **Change** the least that does the job, with \`edit_file\`. One concern per change.
4. **Check** by running what the project uses: its tests, its type checker, its linter.
   Find them in \`package.json\`, the \`Makefile\` or the README before guessing.
5. **Report** what changed, where, and what you ran. A test you did not run is a test you
   say you did not run. A failure is reported with its output, not smoothed over.

## Git and GitHub

- Look before acting: \`git status\`, \`git diff\`, \`git log --oneline -10\`.
- Commit only when asked. A message says what changed, in the style the repository's log
  already uses.
- Never force-push, rewrite published history, delete branches or reset away work unless
  the person asked for exactly that.
- \`gh\` opens pull requests, reads issues and checks runs, once logged in (see
  \`machine-tools\`).

## Judgement

- Match the codebase, not your preferences. A new dependency needs a reason.
- Do not reformat or rename what the task does not touch.
- When the request is ambiguous and the change is large, say what you understood and ask
  before writing it.
- When you are reviewing, say what is wrong and why, with the file and line, and whether it
  blocks.`,
};
