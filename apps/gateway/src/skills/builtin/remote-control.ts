import type { Skill } from '@jian/contracts';

/** Offered with the shell: Remote Control tools exist only when allowShell is on. */
export const remoteControl: Skill = {
  name: 'remote-control',
  description:
    'Use when asked to control a computer the owner connected under Remote Control: run commands there, open apps, take a screenshot, or copy files to or from that machine.',
  instructions: `# Remote Control

The owner connects computers in the panel under **Remote Control**. Each machine has a worker
that polls this gateway over HTTPS. Only profiles the owner authorized for that machine may
use it. Commands run as the logged-in local user — full local privileges, not a sandbox.

Load the \`remote\` tool group with \`load_tools\` before calling these tools.

## The tools

- \`list_remote_machines\` — machines authorized for you: id, name, platform, online.
- \`run_remote_command\` — shell on that computer (PowerShell on Windows, \`/bin/sh\` on
  macOS/Linux). Open apps, install software, Git, builds, scripts — anything a local user
  would type. Prefer the dedicated tools below for screenshots and file transfer.
- \`take_remote_screenshot\` — primary display as a JPEG in this conversation (\`mediaId\`).
  Send it with \`send_file\`. Prefer this over inventing screenshot commands.
- \`pull_remote_file\` — read a remote path into conversation media (size-capped).
- \`push_remote_file\` — write UTF-8 or base64 bytes to a remote path (size-capped).

Gateway \`files\` / \`shell\` tools act on the **gateway host**, not the remote PC. For work
on the remote computer, use the remote tools. Programming there is \`run_remote_command\`
(and push/pull for files). Do not claim a remote action succeeded unless the tool result
confirms it (exit code, stdout, or \`ok: true\`).

## How to work

1. \`list_remote_machines\` and pick an **online** machine the owner named (or confirm which
   one if several). Offline means the worker is not polling — say so; do not invent success.
2. Say one short line before a slow or visible action ("Opening Calculator on Mark.").
3. For "show me the screen", use \`take_remote_screenshot\` then \`send_file\` with that
   \`mediaId\`.
4. For a small file exchange, use pull/push. Larger transfers need an arrangement the owner
   made (cloud folder, \`scp\`, etc.) via \`run_remote_command\`.

## After reboot

The installer registers a per-user auto-start: Windows Task Scheduler **ONLOGON**, macOS
LaunchAgent, or Linux \`systemd --user\`. After a reboot the worker starts when that user
signs in. Until then the machine stays Offline in the panel.

## Limits

- A command stops after at most two minutes (\`timeoutMs\`).
- Screenshot and file payloads travel as base64 on the worker channel (~300 KB binary).
- Never print the worker token or stored credentials into the chat.
`,
};
