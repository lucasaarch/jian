import type { Skill } from '@jian/contracts';

export const machineTools: Skill = {
  name: 'machine-tools',
  description:
    'Use before running commands or installing anything: what the machine has, how to install more without root, logins and keys, and the limits of a command.',
  instructions: `# The machine you run commands on

Commands run with \`run_command\`, in the \`shell\` tool group: load it with \`load_tools\`
first. They run on the machine the gateway runs on, as whoever started it.

You work in a workspace of your own: a directory that is your \`$HOME\`, where a command
starts and where \`$TMPDIR\` points. Keep repositories, logins and installs there. A command
may write only in it and read only it and the system's tools (\`/usr\`, \`/etc\` and the
like); another profile's workspace and the gateway's files are refused, by the kernel where
it supports it. \`/tmp\` is not yours: use \`$TMPDIR\`. The file tools, \`send_file\` and
\`save_attachment\` follow the same line.

A command does not inherit the gateway's environment: it gets \`PATH\`, \`HOME\`, the locale
and a few install paths, and nothing else — no \`DATABASE_URL\`, no \`NODE_ENV\`, no keys.
When a project needs a variable, set it in the command itself. Point database tests at a
database made for them, never at the gateway's own. The network is not restricted.

Check where you are: \`echo $JIAN_TOOLBOX\`. If it prints \`1\` you are in the Jian image and
what follows holds. Otherwise the gateway runs directly on the owner's machine: find what
exists with \`command -v <tool>\`, and install nothing there unless the owner asks.

## Already installed in the image

- Runtimes: Node 24 with npm, pnpm and yarn (through corepack); Python 3 with pip, venv and
  \`uv\`/\`uvx\`; Go.
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

## Installing more

You are the user \`node\`, without root and without \`sudo\`. Your workspace lives on a
volume that survives a new image, so install there:

- Node: \`npm install -g <pkg>\` (lands in \`~/.local\`).
- Python tools: \`uv tool install <pkg>\`. A project: \`uv venv\`, then \`uv pip install\`. A
  bare \`pip install\` is refused by the system Python.
- Go: \`go install <module>@latest\` (lands in \`~/go/bin\`).
- A single binary: download it to \`~/.local/bin\` and \`chmod +x\` it.

There is no \`apt\`. When a task needs a system package, look for a static binary or a
per-user build first; if there is none, tell the owner which package, so it can be added to
the image. Install what the task needs, not what might be handy, and say what you installed.

## Logins and keys

- \`git push\` to a private repository uses the installation's SSH keys; there is no other GitHub
  login in the workspace.
- SSH keys: create them with the SSH key tools (\`ssh-keys\` skill), not \`ssh-keygen\`. The
  gateway points \`git\` at those identities and seeds GitHub’s host keys in
  \`~/.ssh/known_hosts\`.
- Git needs \`git config --global user.name\` and \`user.email\` before a commit.

All of them persist in your workspace, and no other profile can read them. Never print a token, a password or a private key
into the conversation, and never send one anywhere the owner did not ask.

## Limits of a command

- A command stops after at most two minutes (\`timeoutMs\`, 30 seconds unless you raise it).
- Output past about 60,000 characters is cut.
- A long job: split it into steps, or start it in the background writing to a log file, and
  read the log afterwards.

## Before you run something

Say what you are about to do when it changes anything. Never run something destructive — a
delete, an overwrite, a force-push, a migration — that nobody in this conversation asked
for. A command can be held back by the Decisions check; the answer tells you why. Then ask
the owner to confirm that exact action, and do not try to reach the same effect another way.

For reading and changing code, load the \`coding-work\` skill.`,
};
