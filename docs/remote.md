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
required. The token is shown only once; treat the install command as a secret.

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

Credentials stay in `~/.config/jian-remote/config.json`. To refresh the worker to match the
gateway (or `@latest`) and restart the service:

```sh
npx --yes @jian-ai/remote-control@latest update
# or, when installed globally:
jian-remote update
# optional pin:
jian-remote update --version 0.6.0
```

`update` does not take `--gateway`, `--machine`, or `--token`.

### Version compatibility

The worker and gateway must share the same **major.minor** (patch and prerelease may differ).
`install`, `update`, and `run` check `GET /health` for the gateway’s version and refuse to
continue with a clear error when incompatible — for example a 0.5.x worker against a 0.6.x
gateway. Local gateway builds with no `JIAN_VERSION` skip the gate. Fix a mismatch with
`npx @jian-ai/remote-control@GATEWAY_VERSION update`.

The installer stores the credential with owner-only permissions under `~/.config/jian-remote`,
copies the worker script there (so npx and global installs share one service path), and
installs a per-user LaunchAgent on macOS, a systemd service on Linux, or a Task Scheduler
logon task on Windows. The Windows task runs only in the current user's session.

The one-liner puts the token in shell history. Clear history afterwards on a shared machine, or
install by hand with `--token-prompt` / `--token-stdin` instead. The worker source also lives at
`apps/remote-control/bin/jian-remote.mjs` in the Jian source tree. The gateway still serves
`/jian-remote.mjs` for automatic worker self-updates of already-installed machines.

The worker executes Windows commands with PowerShell. The Windows credential directory and file
ACLs are restricted to the current account. To uninstall, delete the `Jian Remote` task in Task
Scheduler and remove `%USERPROFILE%\\.config\\jian-remote`.

Keep the worker script at its installed path: the OS service starts that file. The worker uses
`/bin/sh -lc` on macOS/Linux and PowerShell on Windows, inherits the local user's environment,
and returns at most about 400 KB of stdout (enough for a compressed screenshot or a small file
as base64) and 50 KB of stderr. Oversized results are truncated before upload so the worker does
not stick offline on HTTP 413. Do not authorize profiles that should not have access to those
local privileges.

### Starts again after reboot

Yes — when that user signs in. The installer registers:

- **Windows:** Task Scheduler task `Jian Remote` with trigger `ONLOGON` (interactive, limited).
- **macOS:** LaunchAgent `com.jian.remote` (`RunAtLoad` + `KeepAlive`).
- **Linux:** `systemd --user` unit `jian-remote.service` enabled for the user session.

Until the user logs in (or the user systemd session is lingering), the machine stays offline in
the panel. The Remote Control page polls Online/Offline every few seconds while it is open.

### If the machine stays Offline

1. Confirm the computer can reach the gateway over HTTPS.
2. Run `npx @jian-ai/remote-control@latest update` (or restart the local service). Re-running
   install is only needed if the config was deleted.
3. Read `~/.config/jian-remote/worker.log`. An incompatible-version error means the worker’s
   major.minor does not match the gateway — run `update` against the gateway’s version.
   Repeated `HTTP 502`/`503` means the gateway is up and down — the worker backs off and
   reconnects. Oversized results are truncated so the worker does not stick offline on HTTP 413.

## Agent use and revocation

The agent receives the `remote` tool group only when its profile has `allowShell` enabled:
`list_remote_machines`, `run_remote_command`, `take_remote_screenshot`, `pull_remote_file`, and
`push_remote_file`. Listing returns only machines explicitly authorized for that profile;
each action checks that authorization again. Results include exit code, output, and timeout
status. A machine must be online to accept work. The built-in `remote-control` skill describes
when to use each tool.

To revoke a profile, replace `allowedProfileIds` using the access endpoint above. To disconnect
and invalidate the machine token, delete the machine:

```sh
curl -fsS -X DELETE https://gateway.example/v1/remote/machines/MACHINE_UUID \
  -H "Authorization: Bearer $JIAN_GATEWAY_TOKEN"
```

Deleting a machine removes its queued tasks. This invalidates gateway access immediately;
remove the LaunchAgent/systemd unit and local config from the Mac to stop its polling process
and erase its stored credential. On macOS, run `launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.jian.remote.plist"` and remove that plist; on Linux, run `systemctl --user disable --now jian-remote.service` and remove `~/.config/systemd/user/jian-remote.service`. Then remove `~/.config/jian-remote` from the Mac to erase the credential and log.
