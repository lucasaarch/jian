import type { Skill } from '@jian/contracts';

const PER_AGENT = `Memories, conversations and the browser's logins stay per agent. Files do not.`;

const serverFiles = (
  named: string,
) => `Commands run with \`run_command\`, in the \`shell\` tool group: load it with \`load_tools\`
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
and a few install paths, and nothing else — no \`DATABASE_URL\`, no \`NODE_ENV\`, no keys${named}. When a project needs a variable, set it in the command
itself. Point database tests at a database made for them, never at the gateway's own. The network
is not restricted.

Check where you are: \`echo $JIAN_TOOLBOX\`. If it prints \`1\` you are in the Jian image and
what follows holds. Otherwise the gateway runs directly on the owner's machine: find what
exists with \`command -v <tool>\`, and install nothing there unless the owner asks.

`;

const ownerFiles = (
  named: string,
) => `Commands run with \`run_command\`, in the \`shell\` tool group: load it with \`load_tools\`
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
owner's SSH agent, and nothing else — no \`NODE_ENV\`, no keys${named}. When a project needs a variable, set it in the command itself.

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
- Data and media: \`sqlite3\`, \`psql\`, \`ffmpeg\` and \`ffprobe\`, ImageMagick 6 (\`convert\`,
  \`identify\`, \`montage\`, \`composite\`; no \`magick\`), \`mediainfo\`, \`sox\`. Fonts: DejaVu,
  Liberation, Noto for most scripts, and Noto Color Emoji.

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

/** What a run has of the Secrets: `run_command` lends them, and the agent may also keep them. */
export type SecretsRun = 'none' | 'lend' | 'manage';

const NAMED = ' but the Secrets you name (below)';

const LENDING = `## Secrets

The owner keeps keys and logins for your commands in Jian, such as a transcription service's API
key. A Secret has fields, each one a variable. A password, key or token is sensitive: you never
see its value. A username, region or account id is not, and can be read.

When you have any, \`run_command\`'s description lists them and what each is for. Naming one
variable of a Secret in a command's \`secrets\` lends the whole Secret: every variable of it
reaches that one command as an environment variable. Write \`"$NAME"\` in the command, never a
value; whatever it prints of a sensitive one comes back as [REDACTED]. Where the conversation
asks before acting, the owner approves each such command. When a task needs a key you do not
have, ask the owner to add it in this agent's settings under **Secrets**; never ask them to paste
one into the chat.

`;

const MANAGING = `Where you may keep Secrets, they are in the \`secrets\` tool group: load it with
\`load_tools({ groups: ['secrets'] })\`.

- \`list_secrets\` shows the Secrets you may use, with their fields. Only a field that is not
  sensitive shows its value.
- \`save_secret\` makes a Secret only you may use, from a value you already have, such as one the
  owner typed to you or a key you just made on a site. A sensitive value is masked from that call
  on and a command can use it at once. A value that came back masked, shown as [REDACTED], is
  refused. With \`secretId\` it changes one you made: \`fields\` replace its list,
  and a field without \`value\` keeps the one it has.
- \`delete_secret\` deletes a Secret you made. One the owner or another agent made, you can use
  and not change.
- To use a Secret another agent has, ask that agent with \`ask_agent\`. It lets you use it with
  \`share_secret\`, naming you from \`list_agents\`, and the owner is not asked. Share one the same
  way only when another agent asks you for a job the owner gave it, and never to pass one on that
  it does not need.

The owner sees and edits every Secret, yours included, in this agent's settings under
**Secrets**.

`;

const secretsSection = (secrets: SecretsRun) =>
  secrets === 'none' ? '' : secrets === 'lend' ? LENDING : LENDING + MANAGING;

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
- Output past about 60,000 characters keeps its first and last 30,000; the middle is not kept,
  and a command that prints more than 8 MB is stopped. Send a long output to a file and read the
  part you need.
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

const composed = (owner: boolean, secrets: SecretsRun): string => {
  const named = secrets === 'none' ? '' : NAMED;
  return owner
    ? `# The computer you run commands on\n\n${ownerFiles(named)}${OWNER_LOGINS}${secretsSection(secrets)}${LIMITS}`
    : `# The machine you run commands on\n\n${serverFiles(named)}${IMAGE}${SERVER_INSTALLS}${SERVER_LOGINS}${secretsSection(secrets)}${LIMITS}`;
};

/** What is true where the run is: the two hosts share neither the files nor the rules on them. */
export const machineTools: Skill = {
  name: 'machine-tools',
  description:
    'Use before running commands or installing anything: what the machine has, how to install more without root, logins and keys, Secrets, and the limits of a command.',
  instructions: composed(false, 'manage'),
};

const onOwnerComputer: Skill = {
  ...machineTools,
  instructions: composed(true, 'manage'),
};

/**
 * `secrets` is what the run has: none, a command that may lend them, or the tools to keep them
 * too. Taught only where the run has them, or the agent would look for tools it was not given.
 * Left out, the fullest, as the owner reads it in the panel.
 */
export const machineToolsFor = (owner: boolean, secrets: SecretsRun = 'manage'): Skill => {
  const base = owner ? onOwnerComputer : machineTools;
  return secrets === 'manage' ? base : { ...base, instructions: composed(owner, secrets) };
};

/** Either of the two this file hands out, whatever the host: the run's own is built from them. */
export const isMachineTools = (skill: Skill): boolean =>
  skill === machineTools || skill === onOwnerComputer;
