# Remote Control

Remote Control connects a Windows, Mac, or Linux computer to the gateway with an outbound
HTTPS polling connection. It does not open a port or expose SSH. Profiles must be explicitly
authorized for a machine; the default is no profiles. An authorized profile can execute
arbitrary shell commands automatically as the local user, with that user's filesystem and
process permissions, plus screenshot and file transfer tools. Only enable it for agents and
machines you trust. This is not a sandbox.

## Add a machine

The admin API uses the gateway bearer token. Create a machine with an empty access list by
omitting `allowedProfileIds`, or grant profile UUIDs at creation. The returned worker token is
shown once; keep it private.

```sh
curl -fsS -X POST https://gateway.example/v1/remote/machines \
  -H "Authorization: Bearer $JIAN_GATEWAY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Lucas Mac","allowedProfileIds":["PROFILE_UUID"]}'
```

To change authorization later, replace the entire list (an empty list revokes every profile):

```sh
curl -fsS -X PATCH https://gateway.example/v1/remote/machines/MACHINE_UUID/access \
  -H "Authorization: Bearer $JIAN_GATEWAY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"allowedProfileIds":["PROFILE_UUID"]}'
```

The panel’s Remote Control page shows npm/npx installers after you create a machine. Those
commands install `@jian-ai/remote-control` and embed the one-time token — no clone of Jian is
required. The token is shown only once; treat the install command as a secret. **Rotate
credentials** on an existing machine issues a new token (invalidates the old one) and shows
`configure` / `install` one-liners the same way.

## Install the worker

Install Node.js 24+ on the computer. The published package is `@jian-ai/remote-control` (CLI
`jian-remote`), versioned with each Jian release. The panel pins the running gateway version
when known; otherwise use `@latest`.

Any OS (npx) — copy from the panel, or substitute your values:

```sh
npx --yes @jian-ai/remote-control@latest install \
  --gateway 'https://gateway.example' \
  --machine 'MACHINE_UUID' \
  --token 'WORKER_TOKEN'
```

Global install:

```sh
npm install -g @jian-ai/remote-control@latest
jian-remote install \
  --gateway 'https://gateway.example' \
  --machine 'MACHINE_UUID' \
  --token 'WORKER_TOKEN'
```

### Update (no token again)

Credentials stay in `~/.config/jian-remote/config.json`. To refresh the worker **binary** to match
the gateway (or `@latest`) and restart the service:

```sh
npx --yes @jian-ai/remote-control@latest update
# or, when installed globally:
jian-remote update
# optional pin:
jian-remote update --version 0.6.0
```

`update` does not take `--gateway`, `--machine`, or `--token`.

### Version, stop, start, restart

```sh
jian-remote version          # also: --version / -V
jian-remote stop             # unload LaunchAgent / stop systemd --user / end Task Scheduler job
jian-remote start            # ensure previous worker is dead, then start exactly one
jian-remote restart          # stop then start
```

Success prints a short English block (service kind + started/stopped/restarted). Failure prints
`Error: …` on stderr and exits non-zero. `start` / `restart` / `update` / auto-update always
stop any previous worker (OS job + `~/.config/jian-remote/worker.pid`) before a new process
runs, so two pollers cannot fight after a KeepAlive race.

### Configure (change token or gateway URL)

When the panel rotates credentials, or you move the gateway URL, rewrite the stored config and
restart the service without wiping the LaunchAgent / systemd unit / Windows task:

```sh
# Token only (machine id and gateway stay as stored):
jian-remote configure --token 'WORKER_TOKEN'
# Or via npx:
npx --yes @jian-ai/remote-control@latest configure --token 'WORKER_TOKEN'

# Gateway URL and/or machine id as well:
jian-remote configure --gateway 'https://gateway.example' --token 'WORKER_TOKEN'
jian-remote configure --machine 'MACHINE_UUID' --token 'WORKER_TOKEN'
```

At least one of `--gateway`, `--machine`, or a `--token*` flag is required. Success prints what
changed and that the service restarted; failure prints an English error and exits non-zero.

### Version compatibility and fleet auto-update

The worker and gateway should share the same **release** (`JIAN_VERSION` / package version).
`install` and manual `update` still check `GET /health` and refuse a mismatched build with a
clear error. Local gateway builds with no `JIAN_VERSION` skip the gate.

**Connected workers self-update** so you do not SSH into each machine:

1. On connect and about every five minutes, the worker compares its installed script to the
   gateway’s authenticated `GET /v1/remote/worker/:id/update` (same bytes as public
   `/jian-remote.mjs`, with `PACKAGE_VERSION` stamped to the gateway release).
2. When the script changed (newer **or** older patch, and **major.minor skew** toward the
   gateway), it writes `~/.config/jian-remote/jian-remote.mjs` atomically and exits so the OS
   service reloads: LaunchAgent `KeepAlive` on macOS, `systemd --user` `Restart=always` on
   Linux, or a detached respawn on Windows Task Scheduler.
3. If the gateway update cannot apply but `/health` reports a release version, the worker
   falls back to `npm pack @jian-ai/remote-control@GATEWAY_VERSION`, then restarts the same way.
4. Failed updates **do not** wipe `config.json` or the worker token. Failures are logged,
   recorded in `~/.config/jian-remote/update-state.json`, and retried with exponential backoff
   (up to 30 minutes) so KeepAlive does not crash-loop.
5. Prefer the gateway script. npm is a fallback only when the **installed** script is not yet
   on the gateway release. If npm is missing that version (staged but not promoted), the worker
   keeps the gateway bytes and backs off — it does not bounce forever between an older npm
   tarball and the gateway stamp. A process whose in-memory version is older than the file on
   disk exits so KeepAlive loads the installed script (avoids a stale second poller).

Until an auto-update succeeds across a major.minor skew, the worker will not stay online.
If both the gateway script and npm are unreachable, run
`npx @jian-ai/remote-control@GATEWAY_VERSION update` once on that machine (or fix network to
the gateway / registry).

The installer stores the credential with owner-only permissions under `~/.config/jian-remote`,
copies the worker script there (so npx and global installs share one service path), and
installs a per-user LaunchAgent on macOS, a systemd service on Linux, or a Task Scheduler
logon task on Windows. The Windows task runs only in the current user's session.

### macOS app identity (Login Items / TCC)

On macOS the LaunchAgent does **not** run the system `node` binary. Install materializes a
thin app bundle:

`~/Library/Application Support/Jian Remote/Jian Remote.app`

whose `Contents/MacOS/Jian Remote` is a copy of the Node runtime used at install time
(ad-hoc signed with bundle id `com.jian.remote` when `codesign` is available). The plist
`ProgramArguments` point at that executable plus `~/.config/jian-remote/jian-remote.mjs run`,
and set `AssociatedBundleIdentifiers` to `com.jian.remote`.

System Settings → General → Login Items / Background Items should show **Jian Remote**, not
“Node.js Foundation”. Accessibility and related TCC grants attach to this app path instead of
the shared system Node binary.

**Tradeoffs (v1):** the app is **unsigned / ad-hoc**, not Developer ID–notarized — no Apple
Developer account is required for the npm distribute path. Gatekeeper is usually quiet for
LaunchAgent-started jobs; some TCC prompts may still note an unnotarized app. A later release
can Developer ID–sign and notarize the same layout without changing the install UX. The
embedded runtime is roughly the size of Node and is refreshed on `install` / `update` /
`configure` when the service restarts.

The one-liner puts the token in shell history. Clear history afterwards on a shared machine, or
install by hand with `--token-prompt` / `--token-stdin` instead. The worker source also lives at
`apps/remote-control/bin/jian-remote.mjs` in the Jian source tree. The gateway serves
`/jian-remote.mjs` (public) and the authenticated worker `/update` route for those automatic
self-updates.

The worker executes Windows commands with PowerShell. The Windows credential directory and file
ACLs are restricted to the current account. To uninstall, delete the `Jian Remote` task in Task
Scheduler and remove `%USERPROFILE%\\.config\\jian-remote`.

Keep the worker script at its installed path: the OS service starts that file. The worker uses
absolute `/bin/sh -lc` on macOS/Linux (or `/bin/bash` / `/usr/bin/sh` if needed) and PowerShell
on Windows, inherits a sane `PATH`/`HOME` from the LaunchAgent (or the user session), and returns
at most about 400 KB of stdout and 50 KB of stderr. If `run_remote_command` passes a **cwd** that
does not exist on that computer, the worker falls back to the user’s home directory and notes it
in stderr — Node otherwise reports the misleading `spawn /bin/sh ENOENT` when only the cwd is
missing. Oversized results are truncated before upload so the worker does not stick offline on
HTTP 413.

**Screenshots:** `remote_computer` with `action: screenshot` captures the **primary** display as
JPEG, then **scales and recompresses** on the machine (longest side ≤ 1920, quality stepped down
until the binary is under ~280 KB) so base64 fits the channel. Cutting base64 mid-stream used to
decode as a corrupt image (often a solid grey lower half). The gateway rejects incomplete JPEGs
instead of storing them. File pull/push still need to stay under the same ~300 KB binary budget;
larger files need an owner-arranged transfer via `run_remote_command`. Do not authorize profiles
that should not have access to those local privileges.

### Starts again after reboot

Yes — when that user signs in. The installer registers:

- **Windows:** Task Scheduler task `Jian Remote` with trigger `ONLOGON` (interactive, limited).
- **macOS:** LaunchAgent `com.jian.remote` (`RunAtLoad` + `KeepAlive` + `ThrottleInterval`, with
  an explicit `PATH` for the app-identity Node binary).
- **Linux:** `systemd --user` unit `jian-remote.service` enabled for the user session.

Until the user logs in (or the user systemd session is lingering), the machine stays offline in
the panel. The Remote Control page polls Online/Offline every few seconds while it is open.

### Check status and logs (macOS)

A successful `install` prints that the LaunchAgent started, that credentials are in
`~/.config/jian-remote/config.json`, and how to upgrade later. A failure prints an English
error on stderr and exits non-zero. If the command prints nothing at all, the CLI did not
run — that was a bug in `@jian-ai/remote-control@0.7.0` when invoked through npm's symlink
bin; use a newer package (or run the `.mjs` by absolute path).

After install:

```sh
# Config and installed worker script (owner-only directory)
ls -la ~/.config/jian-remote

# LaunchAgent plist (ProgramArguments[0] should be …/Jian Remote.app/Contents/MacOS/Jian Remote)
ls -la ~/Library/LaunchAgents/com.jian.remote.plist
plutil -p ~/Library/LaunchAgents/com.jian.remote.plist | head
ls -la ~/Library/Application\ Support/Jian\ Remote/Jian\ Remote.app/Contents/MacOS/

# Is the job loaded? Look for com.jian.remote (PID and last exit status).
launchctl print "gui/$(id -u)/com.jian.remote"

# Or a short list line:
launchctl list | grep com.jian.remote

# Worker stdout/stderr (created once launchd starts the job)
tail -f ~/.config/jian-remote/worker.log
```

A healthy log starts with a line like `Connected to Jian Remote at https://… (worker …)`.
`launchctl list` shows a PID (not `-`) when the process is up; a non-zero last-exit status
with `KeepAlive` means it is crashing and restarting — read the log.

Restart without re-entering the token:

```sh
jian-remote restart
# or refresh the binary then restart:
npx --yes @jian-ai/remote-control@latest update
# low-level launchd bounce (prefer jian-remote restart):
launchctl kickstart -k "gui/$(id -u)/com.jian.remote"
```

### If the machine stays Offline

1. Confirm the computer can reach the gateway over HTTPS.
2. Run `npx @jian-ai/remote-control@latest update` (or restart the local service). Re-running
   install is only needed if the config was deleted. On macOS, `update` also refreshes the
   LaunchAgent (`ProcessType=Interactive`) so App Nap does not freeze the poller when the
   screen is locked.
3. Read `~/.config/jian-remote/worker.log`. An incompatible-version error after auto-update
   backoff means the worker could not download the gateway’s script (or npm package) —
   fix reachability or run `update` against the gateway’s version once. Repeated
   `HTTP 502`/`503` means the gateway is up and down — the worker backs off and reconnects.
   Oversized results are truncated so the worker does not stick offline on HTTP 413.
4. If the panel shows **Online** plus **Locked**, the worker is fine — unlock the Mac for
   Computer Use; shell may still run.

## Agent use and revocation

The agent always receives the `remote` tool group when Remote Control is configured on the
gateway: `list_remote_machines`, `run_remote_command`, `remote_computer`, `pull_remote_file`,
and `push_remote_file`. Listing returns only machines explicitly authorized for that profile;
each action checks that authorization again. **Machine ACL is the only gate** for remote shell
and computer use — not the deprecated profile `allowShell` flag (workspace shell on the gateway
is always available and confined to the profile workspace). Results include exit code, output,
and timeout status. A machine must be online to accept work. Computer use additionally needs
a worker capability `computer-macos-v1`, `computer-linux-v1`, or `computer-windows-v1`. The
built-in `remote-control` skill describes when to use each tool.

### Computer use (macOS, Linux, Windows)

`remote_computer` drives the **primary display** with Anthropic-style actions (`screenshot`,
clicks, move, type, key, scroll, drag, wait, `end_session`). Coordinates are pixels in the
scaled JPEG the tool returns (`widthPx` × `heightPx`). Screenshots are compressed on the
machine (longest side ≤ 1600, ~280 KB binary). The worker shows a **Jian overlay** pointer
(geometric white arrow with a soft blue glow) while a session is open; after ~30s idle it
stays visible but very translucent; `end_session` removes it.

**Pointer UX:** the overlay is the visible agent cursor. Clicks briefly warp the system cursor
to the target (required for HID injection) then **restore** the user’s previous position so
the physical mouse is not left at the Jian point. Overlay motion is ease-out interpolated
between positions (capped ~110 ms) so moves slide instead of teleporting.

| OS | Capability | Screenshot | Input + overlay | Notes |
| --- | --- | --- | --- | --- |
| macOS | `computer-macos-v1` | `screencapture` + `sips` | Swift helper (`CGEvent` + AppKit panel) | Grant **Screen Recording** and **Accessibility** to **Jian Remote**. Published packages ship a prebuilt universal helper (no Xcode on the worker Mac). |
| Linux | `computer-linux-v1` | `ffmpeg` x11grab | Python helper + `xdotool` (X11 overlay) | Needs `DISPLAY`, `xdotool`, `ffmpeg`, and `python3`. Pure Wayland without XWayland/`xdotool` is not advertised yet. |
| Windows | `computer-windows-v1` | System.Drawing | PowerShell helper (`SendInput` + WinForms overlay) | Interactive desktop session (Task Scheduler logon task). |

Published `@jian-ai/remote-control` releases ship a **prebuilt universal** macOS `computer-helper`
(arm64 + x86_64) built on macOS in the Publish workflow, plus the Linux/Windows helper scripts.
`install` / `update` materialize them under the local Jian Remote support directory. From a
source checkout on a Mac, `macos/build-helper.sh` (or `swiftc` on first use) builds the macOS
binary when Command Line Tools are present. Developer ID signing and notarization of the macOS
helper are optional Publish steps when repository secrets are configured (see below); full
Developer ID + notarization of **Jian Remote.app** remains a separate follow-up.

### Online vs locked vs asleep (macOS)

**Online** means the worker is still polling the gateway (HTTPS `tasks/next`), not that the
desktop is unlocked. The panel and `list_remote_machines` also expose `uiState`:

| `uiState` | Meaning | Shell / files | Computer Use |
| --- | --- | --- | --- |
| `unlocked` | Session unlocked, display up | Yes | Yes |
| `display_asleep` | Display off/asleep, not password-locked | Yes | Worker wakes the display when a session starts |
| `locked` | Password lock / loginwindow | Yes while online | **Screenshot** may work after waking the display (lock UI only). Click / type / key / scroll / drag need unlock. Desktop apps behind the lock are not visible. |
| `unknown` | Probe unavailable | Yes while online | Best-effort; may fail with a normal tool error |

A locked Mac that still looks **Offline** is usually an old LaunchAgent without
`ProcessType=Interactive` (App Nap freezing the Node poll loop) or true system sleep
(lid closed without power policy). Run `npx @jian-ai/remote-control@latest update` (or
re-install) so launchd rewrites the plist, then check `~/.config/jian-remote/worker.log`.

While a computer-use session is open the worker holds `caffeinate` assertions so idle
display sleep is less likely to interrupt it. A locked Mac often also has the display
asleep; the worker runs `caffeinate -u` before a screenshot so capture is not confused
with “lock blocks Screen Recording.” You may get the lock screen image (or black if wake
failed) — not Finder/Chrome behind loginwindow. That is an OS limit, not ChatGPT-style
“locked Computer Use” (those products use a separate macOS authorization plugin).
Lid-closed clamshell sleep still takes the machine truly offline until it wakes.

#### Optional Apple signing secrets (Publish)

Do not put certificates in chat or commit them. If the team enables Developer ID for the helper,
set these GitHub Actions secrets (Developer ID **Application** `.p12`, plus App Store Connect
API key for notarytool):

- `APPLE_DEVELOPER_ID_P12` — base64-encoded `.p12`
- `APPLE_DEVELOPER_ID_P12_PASSWORD`
- `APPLE_TEAM_ID`
- `APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID` / `APPLE_API_KEY_P8` — notarization (optional)

Without those secrets, Publish still ships an ad-hoc–signed helper (same class as today’s
**Jian Remote.app**).

To revoke a profile, replace `allowedProfileIds` using the access endpoint above. To disconnect
and invalidate the machine token, delete the machine:

```sh
curl -fsS -X DELETE https://gateway.example/v1/remote/machines/MACHINE_UUID \
  -H "Authorization: Bearer $JIAN_GATEWAY_TOKEN"
```

Deleting a machine removes its queued tasks. This invalidates gateway access immediately;
remove the LaunchAgent/systemd unit and local config from the Mac to stop its polling process
and erase its stored credential. On macOS, run `launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.jian.remote.plist"` and remove that plist; on Linux, run `systemctl --user disable --now jian-remote.service` and remove `~/.config/systemd/user/jian-remote.service`. Then remove `~/.config/jian-remote` from the Mac to erase the credential and log.
