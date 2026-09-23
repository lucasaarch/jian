import type { Skill } from '@jian/contracts';

export const machineTools: Skill = {
  name: 'machine-tools',
  description:
    'Use before running commands: what the machine already has, how to install more, and what survives an update.',
  instructions: `# The machine you run commands on

Check first: \`echo $JIAN_TOOLBOX\`. If it prints \`1\` you are in the Jian image and what
follows holds. Otherwise the gateway runs straight on the owner's machine: find what exists
with \`command -v <tool>\`, and install nothing there without the owner asking.

## Already installed

- Runtimes: Node 24 with npm, pnpm and yarn (through corepack); Python 3 with pip, venv and
  \`uv\`/\`uvx\`; Go (\`go\`).
- Version control and the network: \`git\`, \`gh\`, \`ssh\`, \`scp\`, \`curl\`, \`wget\`, \`rsync\`.
- Text: \`sed\`, \`awk\` (gawk), \`grep\`, \`rg\` (ripgrep), \`fd\`, \`jq\`, \`diff\`, \`patch\`,
  \`less\`, \`nano\`, \`vi\`, \`tree\`, \`file\`.
- Archives: \`tar\`, \`zip\`/\`unzip\`, \`xz\`, \`bzip2\`, \`zstd\`.
- Builds: \`gcc\`, \`g++\`, \`make\`, \`pkg-config\`.
- Diagnosis: \`ps\`, \`kill\`, \`lsof\`, \`ip\`, \`ping\`, \`dig\`, \`nc\`.
- Data and media: \`sqlite3\`, \`psql\`, \`ffmpeg\`.

## Installing more

You run as the user \`node\`, without root and without \`sudo\`. Everything under
\`/home/node\` lives on a volume and survives a new image, so install there:

- Node: \`npm install -g <pkg>\` (lands in \`~/.local\`).
- Python CLI: \`uv tool install <pkg>\`. A project: \`uv venv\` and \`uv pip install\`. Not a
  bare \`pip install\`: the system Python refuses it.
- Go: \`go install <module>@latest\` (lands in \`~/go/bin\`).
- A single binary: download it to \`~/.local/bin\` and \`chmod +x\` it.

\`apt\` is not available. When a task truly needs a system package, look for a static
binary or a per-user build first; if there is none, tell the owner which package, so it can
be added to the image. \`ping\` may be refused on some hosts.

Install what the task needs, not what might be handy. Say what you installed.

## Logins and keys

\`gh\` needs a token: \`gh auth login --with-token\` reading it from the owner, or \`GH_TOKEN\`
in the command's environment. SSH keys go in \`~/.ssh\` with mode \`600\`, and Git needs
\`git config --global user.name\` and \`user.email\` before a commit. All three persist in the
home volume. Never print a token or a private key back into the conversation.

## Working on code

Use the file tools, not the shell, to read and change files: \`read_file\` returns numbered
lines, \`edit_file\` replaces exact passages without rewriting the rest, \`search_files\` and
\`find_files\` sweep a codebase. A file must be read in this run before it is changed, and is
refused if it changed since. Keep \`run_command\` for builds, tests, Git and everything else.

## Limits

A command stops after two minutes at most, and output past about 60,000 characters is cut.
Split a long build into steps, or send it to the background and write its log to a file you
read afterwards.
`,
};
