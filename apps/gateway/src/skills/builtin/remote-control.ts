import type { Skill } from '@jian/contracts';

const DESCRIPTION =
  'Use when asked to control a computer the owner connected under Machines: run commands there, drive the screen (click, type, scroll), take a screenshot, or copy files to or from that machine.';

/** The sentence about where the file and shell tools act, by what this run has. */
function whereTools(machine?: { files: boolean }): string {
  if (machine?.files) {
    return `In this conversation the file tools act on its machine (see below). Commands go through
\`run_remote_command\`.`;
  }
  if (machine) {
    // Such a run has neither file nor shell tools: only the remote ones reach anything.
    return `You have no file tools on this conversation's machine: commands and files there go through
\`run_remote_command\`, and pull/push copy a file. Updating its Jian Remote (\`update_remote_machine\`;
for This computer, update the desktop app) gives you file tools there.`;
  }
  return `Gateway \`files\` / \`shell\` tools act on the **gateway host**, not the remote
PC. For work on the remote computer, use the remote tools.`;
}

/** Only a run whose file tools reach its machine is told what they do there. */
function machineFiles(machine?: { files: boolean }): string {
  if (!machine?.files) return '';
  return `
## File tools on this conversation's machine

\`read_file\`, \`edit_file\`, \`write_file\`, \`find_files\`, \`search_files\` and \`list_directory\` (the
\`files\` group) work on the machine this conversation targets, not on the gateway. Give absolute
paths in the machine's own form (\`/Users/…\`, \`C:\\…\`), on Windows always with the drive
letter. They run as the logged-in user, so they open what that user can, except Jian Remote's own
folder and its credentials.

- Read a file with \`read_file\` before you change it; a change is refused when the file changed
  since you read it, and you then read it again.
- A read carries about 400,000 characters at most on a machine, and the whole file is refused
  above that, whatever \`offset\` and \`limit\` say; beyond that read it with \`run_remote_command\`
  (\`head\`, \`tail\` or \`sed\`, or \`Get-Content\` on Windows). A result shows at most 2,000 lines,
  so read a long file in parts. A single write is at most 400,000 characters; for more, write it
  in pieces or use \`run_remote_command\`.
- \`list_directory\` shows 300 entries, \`find_files\` 1,000, and \`search_files\` at most 2,000 matches
  in 60,000 characters; narrow the path or the pattern when a result says it is cut. A find or a
  search stops after 30 seconds with what it found so far, also marked cut, and \`find_files\`
  skips \`/proc\`, \`/sys\` and \`/dev\`.
- In a worktree on the machine they refuse writes in its source folder, as on the gateway.
- Builds, tests and Git still run with \`run_remote_command\`, which needs its \`cwd\`.
- A subagent of this conversation works on the gateway with the gateway's file tools and
  \`run_command\`, not on the machine.
`;
}

export function remoteControlFor(machine?: { files: boolean }): Skill {
  return {
    name: 'remote-control',
    description: DESCRIPTION,
    instructions: body(machine),
  };
}

/** As the panel lists it, for a conversation that targets no machine. */
export const remoteControl: Skill = remoteControlFor();

function body(machine?: { files: boolean }): string {
  return `# Machines

The owner connects computers in the panel under **Machines**. A desktop app connected to this
gateway is one of them by itself, listed as This computer, for as long as the app is open. Each
machine has a worker that polls this gateway over HTTPS. Every agent may use every connected machine, for shell
and computer use alike. Commands and GUI actions run as the
logged-in local user — full local privileges, not a sandbox.

Load the \`remote\` tool group with \`load_tools\` before calling these tools.

## The tools

- \`list_remote_machines\` — the connected machines: id, name, system (the OS and its version),
  platform (OS and architecture), online, uiState, capabilities, version, outdated, updatable.
- \`update_remote_machine\` — bring a machine's Jian Remote to this gateway's release. It
  restarts on the new one when done. Only machines with \`updatable: true\` (installed with
  npm) can; for the others, tell the owner to run \`jian-remote update\` on that computer.
- \`run_remote_command\` — shell on that computer (PowerShell on Windows, \`/bin/sh\` on
  macOS/Linux). Open apps, install software, Git, builds, scripts — anything a local user
  would type. Prefer \`remote_computer\` for GUI and screenshots, and pull/push for files.
  In a conversation that targets the machine, clone, fetch, pull and push GitHub repositories
  there with \`github_git\` (\`github\` skill), which lends the GitHub App's access to it.
- \`remote_computer\` — Anthropic-style desktop control on **macOS, Linux (X11), and Windows**
  (primary display): \`screenshot\`, \`left_click\`, \`right_click\`, \`double_click\`,
  \`mouse_move\`, \`type\`, \`key\`, \`scroll\`, \`left_click_drag\`, \`wait\`, \`end_session\`.
  Coordinates are pixels in the screenshot image (origin top-left); use the returned
  \`widthPx\` / \`heightPx\`. A Jian overlay pointer is visible while the session is open;
  call \`end_session\` when finished so it disappears.
- \`pull_remote_file\` — read an absolute remote path into conversation media, up to 300,000 bytes; a
  larger file fails, so split or compress it with \`run_remote_command\` first.
- \`push_remote_file\` — write UTF-8 or base64 bytes to an absolute remote path, up to 300,000 bytes. A
  machine with an older Jian Remote takes only a few KB (the error names the size): update it first.

${whereTools(machine)} Do not claim a remote action
succeeded unless the tool result confirms it (exit code, stdout, or \`ok: true\`).
${machineFiles(machine)}
## How to work

1. \`list_remote_machines\` and pick an **online** machine the owner named (or confirm which
   one if several). Offline means the worker is not polling — say so; do not invent success.
   \`uiState: locked\` means the Mac is locked but still **online**: keep using shell, files,
   and Computer Use. The worker wakes the display and attempts the action; only treat a
   failed tool result as failure — do not invent “offline” or skip work because of uiState.
   \`outdated: true\` means its Jian Remote is on another release than this gateway: every
   other tool refuses it until \`update_remote_machine\` brings it up to date.
   Computer use needs capability \`computer-macos-v1\`, \`computer-linux-v1\`, or
   \`computer-windows-v1\` (updated Jian Remote on that OS).
2. Say one short line before a slow or visible action ("Opening Calculator on the Studio Mac.").
3. For GUI work: \`remote_computer\` with \`action: screenshot\` first, then click/type using
   those image coordinates; screenshot again after meaningful UI changes — not after every
   keystroke. Prefer \`run_remote_command\` when a CLI exists.
4. When done with the GUI, \`remote_computer\` with \`action: end_session\`.
5. For "show me the screen", screenshot then \`send_file\` with that \`mediaId\`.
6. For a small file exchange, use pull/push. Larger transfers need an arrangement the owner
   made (cloud folder, \`scp\`, etc.) via \`run_remote_command\`.

## After reboot

The installer registers an auto-start: Windows Task Scheduler **ONLOGON**, macOS LaunchAgent, or
Linux \`systemd --user\`, or a system unit on a server with no user session. After a reboot a
per-user worker starts when that user signs in, and until then the machine stays offline in the
panel. A desktop app's own machine comes and goes with the app.

## Limits

- A command or computer action stops after at most two minutes (\`timeoutMs\`).
- Screenshot and file payloads travel as base64 on the worker channel (~300 KB binary).
  Screenshots are scaled/recompressed on the remote machine to fit.
- macOS computer use needs **Screen Recording** and **Accessibility** for **Jian Remote** in
  System Settings. Linux needs an X11 session (XWayland reaches only XWayland apps). Windows needs an
  interactive desktop session. If a tool result says permissions or tools are missing, tell
  the owner — do not invent shell workarounds that bypass Jian’s app identity.
- A **locked** Mac (post-login password lock) stays online. Jian attempts Computer Use after
  waking the display; soft-refusing because of \`uiState\` is wrong. FileVault loginwindow
  before anyone signs in is a different limit. Lid-closed system sleep is true offline
  until the Mac wakes.
- Never print the worker token or stored credentials into the chat.
`;
}
