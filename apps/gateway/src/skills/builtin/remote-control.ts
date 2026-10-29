import type { Skill } from '@jian/contracts';

/** Offered with the workspace shell skills: every agent may use every connected machine. */
export const remoteControl: Skill = {
  name: 'remote-control',
  description:
    'Use when asked to control a computer the owner connected under Remote Control: run commands there, drive the screen (click, type, scroll), take a screenshot, or copy files to or from that machine.',
  instructions: `# Remote Control

The owner connects computers in the panel under **Remote Control**. Each machine has a worker
that polls this gateway over HTTPS. Every agent may use every connected machine, for shell
and computer use alike. Commands and GUI actions run as the
logged-in local user — full local privileges, not a sandbox.

Load the \`remote\` tool group with \`load_tools\` before calling these tools.

## The tools

- \`list_remote_machines\` — the connected machines: id, name, platform, online, uiState,
  capabilities.
- \`run_remote_command\` — shell on that computer (PowerShell on Windows, \`/bin/sh\` on
  macOS/Linux). Open apps, install software, Git, builds, scripts — anything a local user
  would type. Prefer \`remote_computer\` for GUI and screenshots, and pull/push for files.
- \`remote_computer\` — Anthropic-style desktop control on **macOS, Linux (X11), and Windows**
  (primary display): \`screenshot\`, \`left_click\`, \`right_click\`, \`double_click\`,
  \`mouse_move\`, \`type\`, \`key\`, \`scroll\`, \`left_click_drag\`, \`wait\`, \`end_session\`.
  Coordinates are pixels in the screenshot image (origin top-left); use the returned
  \`widthPx\` / \`heightPx\`. A Jian overlay pointer is visible while the session is open;
  call \`end_session\` when finished so it disappears.
- \`pull_remote_file\` — read a remote path into conversation media (size-capped).
- \`push_remote_file\` — write UTF-8 or base64 bytes to a remote path (size-capped).

Gateway \`files\` / \`shell\` tools act on the **gateway host** (your workspace), not the remote
PC. For work on the remote computer, use the remote tools. Do not claim a remote action
succeeded unless the tool result confirms it (exit code, stdout, or \`ok: true\`).

## How to work

1. \`list_remote_machines\` and pick an **online** machine the owner named (or confirm which
   one if several). Offline means the worker is not polling — say so; do not invent success.
   \`uiState: locked\` means the Mac is locked but still **online**: keep using shell, files,
   and Computer Use. The worker wakes the display and attempts the action; only treat a
   failed tool result as failure — do not invent “offline” or skip work because of uiState.
   Computer use needs capability \`computer-macos-v1\`, \`computer-linux-v1\`, or
   \`computer-windows-v1\` (updated Jian Remote on that OS).
2. Say one short line before a slow or visible action ("Opening Calculator on Mark.").
3. For GUI work: \`remote_computer\` with \`action: screenshot\` first, then click/type using
   those image coordinates; screenshot again after meaningful UI changes — not after every
   keystroke. Prefer \`run_remote_command\` when a CLI exists.
4. When done with the GUI, \`remote_computer\` with \`action: end_session\`.
5. For "show me the screen", screenshot then \`send_file\` with that \`mediaId\`.
6. For a small file exchange, use pull/push. Larger transfers need an arrangement the owner
   made (cloud folder, \`scp\`, etc.) via \`run_remote_command\`.

## After reboot

The installer registers a per-user auto-start: Windows Task Scheduler **ONLOGON**, macOS
LaunchAgent, or Linux \`systemd --user\`. After a reboot the worker starts when that user
signs in. Until then the machine stays offline in the panel.

## Limits

- A command or computer action stops after at most two minutes (\`timeoutMs\`).
- Screenshot and file payloads travel as base64 on the worker channel (~300 KB binary).
  Screenshots are scaled/recompressed on the remote machine to fit.
- macOS computer use needs **Screen Recording** and **Accessibility** for **Jian Remote** in
  System Settings. Linux needs an X11 session with \`xdotool\` and \`ffmpeg\`. Windows needs an
  interactive desktop session. If a tool result says permissions or tools are missing, tell
  the owner — do not invent shell workarounds that bypass Jian’s app identity.
- A **locked** Mac (post-login password lock) stays online. Jian attempts Computer Use after
  waking the display; soft-refusing because of \`uiState\` is wrong. FileVault loginwindow
  before anyone signs in is a different limit. Lid-closed system sleep is true offline
  until the Mac wakes.
- Never print the worker token or stored credentials into the chat.
`,
};
