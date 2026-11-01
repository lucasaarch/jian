import type { Skill } from '@jian/contracts';

const PER_AGENT = `Memories, conversations, skills and the browser's logins stay per agent. Files do not.`;

const SERVER_FILES = `Commands run with \`run_command\`, in the \`shell\` tool group: load it with \`load_tools\`
first. They run on the machine the gateway runs on, as whoever started it.

Every agent of this installation works in one shared directory. It is your \`$HOME\`, a command
starts there, and \`$TMPDIR\` is its \`tmp\` folder. ${PER_AGENT} So other agents' work is in
here, and they can read and overwrite yours:

- Keep each task in a folder of its own, such as \`~/tasks/invoice-export\`. Do not assume you are
  alone in \`~\`, and do not clean up, rename or overwrite what you did not create.
- Folders named by a long id hold the work of earlier versions. Leave them where they are: old
  conversations point into them.
- \`$TMPDIR\` is shared too: make your own folder there with \`mktemp -d\`. \`/tmp\` is not yours.

A command may write only in this directory and read only it and the system's tools (\`/usr\`,
\`/etc\` and the like); the gateway's files and process are refused, by the kernel where it
supports it. The file tools, \`send_file\` and \`save_attachment\` follow the same line.

A command does not inherit the gateway's environment: it gets \`PATH\`, \`HOME\`, the locale
and a few install paths, and nothing else — no \`DATABASE_URL\`, no \`NODE_ENV\`, no keys.
When a project needs a variable, set it in the command itself. Point database tests at a
database made for them, never at the gateway's own. The network is not restricted.

Check where you are: \`echo $JIAN_TOOLBOX\`. If it prints \`1\` you are in the Jian image and
what follows holds. Otherwise the gateway runs directly on the owner's machine: find what
exists with \`command -v <tool>\`, and install nothing there unless the owner asks.

`;

const OWNER_FILES = `Commands run with \`run_command\`, in the \`shell\` tool group: load it with \`load_tools\`
first. They run on the owner's own computer, as the owner.

\`$HOME\` is the owner's real home. A command starts there, or in this chat's first folder when it
has one. \`$TMPDIR\` is a folder of Jian's in the system's temporary directory. Every agent of this
installation shares these files. ${PER_AGENT}

- What is here is the owner's own. Touch only what the task needs, and never delete, move or
  overwrite something of theirs that nobody asked you to.
- Do not change \`~/.ssh\`, \`~/.gitconfig\` or any other dotfile unless the owner asks for exactly
  that. Jian keeps what it needs elsewhere.
- A new clone with no folder chosen goes under \`~/Jian\`, which \`github_git\` does by default. Keep
  your own work there too, in a folder for each task, rather than loose in \`~\`.
- Do not assume you are alone: another agent may be working in the same folder.

The file tools, \`send_file\` and \`save_attachment\` reach anything the owner's user can, with one
exception: Jian's own data, the app's data folder with its database and credentials. They refuse
it, through a link too, and say so. Its old \`workspaces\` folder stays open, with earlier work.

Nothing confines a command here: it can reach all that the owner's user can, the network included,
and the refusal above does not stop it. That calls for care, and is no way around a refusal: never
read Jian's own data through a command.

A command does not inherit the gateway's environment: it gets \`PATH\`, \`HOME\`, the locale and the
owner's SSH agent, and nothing else — no \`NODE_ENV\`, no keys of the gateway's. When a project
needs a variable, set it in the command itself.

Find what exists with \`command -v <tool>\`, and install nothing here unless the owner asks.

`;

const IMAGE = `## Already installed in the image

- Runtimes: Node 24 with npm, pnpm and yarn (through corepack); Python 3 with pip, venv and
  \`uv\`/\`uvx\`; Go; Rust with \`cargo\`, \`rustfmt\` and \`clippy\`.
- Git and the network: \`git\`, \`ssh\`, \`scp\`, \`curl\`, \`wget\`, \`rsync\`. GitHub's
  API is reached through its MCP server (\`github\` skill), not a CLI.
- Text: \`rg\` (ripgrep), \`fd\`, \`jq\`, \`sed\`, \`awk\`, \`grep\`, \`diff\`, \`patch\`, \`tree\`,
  \`file\`, \`less\`, \`nano\`, \`vi\`.
- Archives: \`tar\`, \`zip\`/\`unzip\`, \`xz\`, \`bzip2\`, \`zstd\`.
- Builds: \`gcc\`, \`g++\`, \`make\`, \`pkg-config\`.
- Diagnosis: \`ps\`, \`kill\`, \`lsof\`, \`ip\`, \`ping\`, \`dig\`, \`nc\`.
- Data and media: \`sqlite3\`, \`psql\`, \`ffmpeg\`.

## GUI applications and screenshots

The image includes \`jian-display -- COMMAND [ARG ...]\`: one fresh authenticated Xvfb
for that command, with software Mesa OpenGL (llvmpipe) and Vulkan (lavapipe). Use it inside
\`run_command\`; do not start a shared X server, disable authentication or grant access to
\`/tmp\` or \`/dev/shm\`. No desktop, VNC or GPU device is needed.

Run the application and capture in the SAME invocation; another tool call cannot reuse
this display. For example (replace \`my-gui-app\` with the actual executable):

\`\`\`sh
jian-display -- sh -c '
  my-gui-app &
  sleep 3
  xwd -root -silent -out "$HOME/screenshot.xwd"
  ffmpeg -y -i "$HOME/screenshot.xwd" -frames:v 1 "$HOME/screenshot.png"
'
\`\`\`

Then send \`screenshot.png\` with the existing file/media tools. Select the X11 backend
when an app requires it; Wayland is not provided. The wrapper resets display/authority
and runtime paths, disables MIT-SHM, and stops the server/app process groups at exit.
The hard lifetime is 110 seconds including startup; set \`run_command.timeoutMs\` to
120000 for longer captures. \`JIAN_DISPLAY_TIMEOUT_SECONDS\` can shorten, never extend,
the wrapper limit. Exit 124 means timeout, 125 means setup/server failure; other exit
codes come from the command. This is not a persistent interactive GUI session.

`;

const SERVER_INSTALLS = `## Installing more

You are the user \`node\`, without root and without \`sudo\`. The shared directory lives on a
volume that survives a new image, so install there. What you install is there for every agent:

- Node: \`npm install -g <pkg>\` (lands in \`~/.local\`).
- Python tools: \`uv tool install <pkg>\`. A project: \`uv venv\`, then \`uv pip install\`. A
  bare \`pip install\` is refused by the system Python.
- Go: \`go install <module>@latest\` (lands in \`~/go/bin\`).
- A single binary: download it to \`~/.local/bin\` and \`chmod +x\` it.

There is no \`apt\`. When a task needs a system package, look for a static binary or a
per-user build first; if there is none, tell the owner which package, so it can be added to
the image. Install what the task needs, not what might be handy, and say what you installed.

`;

const SERVER_LOGINS = `## Logins and keys

- The shell's \`git\` reaches private repositories with the installation's SSH keys only. For
  GitHub, when the owner connected it, clone, fetch, pull and push with \`github_git\`
  (\`github\` skill), which lends the GitHub App's access to that one command.
- SSH keys: create them with the SSH key tools (\`ssh-keys\` skill), not \`ssh-keygen\`. The
  gateway points \`git\` at those identities and seeds GitHub’s host keys in
  \`~/.ssh/known_hosts\`.
- Git needs \`user.name\` and \`user.email\` before a commit. Set them in the repository with
  \`git config\`, not \`--global\`: \`~/.gitconfig\` is every agent's.

All of them persist in the shared directory, where every agent can read them. Never print a
token, a password or a private key into the conversation, and never send one anywhere the owner
did not ask.

`;

const OWNER_LOGINS = `## Logins and keys

- The owner's own Git and SSH setup applies to your commands: their \`~/.gitconfig\`, their
  \`~/.ssh/config\`, their keys and their SSH agent. Use it; do not change it.
- For GitHub, when the owner connected it, clone, fetch, pull and push with \`github_git\`
  (\`github\` skill), which lends the GitHub App's access to that one command.
- SSH keys of the installation: create them with the SSH key tools (\`ssh-keys\` skill), not
  \`ssh-keygen\`. The gateway keeps them in Jian's own data, away from \`~/.ssh\`, and points
  \`git\` at them alongside the owner's.

Never print a token, a password or a private key into the conversation, and never send one
anywhere the owner did not ask.

`;

const LIMITS = `## Limits of a command

- A command stops after at most two minutes (\`timeoutMs\`, 30 seconds unless you raise it).
- Output past about 60,000 characters is cut.
- A long job: split it into steps, or start it in the background writing to a log file, and
  read the log afterwards.

## Before you run something

Say what you are about to do when it changes anything. Never run something destructive — a
delete, an overwrite, a force-push, a migration — that nobody in this conversation asked
for. In a conversation that asks before acting, a command waits for approval: the person
sees what it will do and decides, and the turn carries on with their answer. Make the call
exactly as you mean it, because what is approved is that call. When the answer says nobody
here may approve, say what you would run and do not try to reach the same effect another way.

For reading and changing code, load the \`coding-work\` skill.`;

/** What is true where the run is: the two hosts share neither the files nor the rules on them. */
export const machineTools: Skill = {
  name: 'machine-tools',
  description:
    'Use before running commands or installing anything: what the machine has, how to install more without root, logins and keys, and the limits of a command.',
  instructions: `# The machine you run commands on\n\n${SERVER_FILES}${IMAGE}${SERVER_INSTALLS}${SERVER_LOGINS}${LIMITS}`,
};

const onOwnerComputer: Skill = {
  ...machineTools,
  instructions: `# The computer you run commands on\n\n${OWNER_FILES}${OWNER_LOGINS}${LIMITS}`,
};

export const machineToolsFor = (owner: boolean): Skill => (owner ? onOwnerComputer : machineTools);
