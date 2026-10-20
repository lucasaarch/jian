# Jian Remote

Jian Remote connects a Mac (or Linux host) to the gateway with an outbound HTTPS polling
connection. It does not open a port or expose SSH. Profiles must be explicitly authorized for
a machine; the default is no profiles. An authorized profile can execute arbitrary shell
commands automatically as the local user, with that user's filesystem and process permissions.
Only enable it for agents and machines you trust. This is not a sandbox.

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

The panel’s Remote Control page shows a one-line installer after you create a machine. That
command downloads the worker from the gateway and embeds the one-time token — no clone of Jian
is required. The token is shown only once; treat the install command as a secret.

## Install the worker

Install Node.js 24+ on the computer. The gateway serves the worker script at
`https://gateway.example/jian-remote.mjs` (same origin as the panel). The installer stores the
credential with owner-only permissions and installs a per-user LaunchAgent on macOS, a systemd
service on Linux, or a Task Scheduler logon task on Windows. The Windows task runs only in the
current user's session.

Windows (PowerShell) — copy from the panel, or substitute your values:

```powershell
$dir="$env:USERPROFILE\.config\jian-remote"; New-Item -ItemType Directory -Force -Path $dir | Out-Null; irm 'https://gateway.example/jian-remote.mjs' -OutFile "$dir\jian-remote.mjs"; node "$dir\jian-remote.mjs" install --gateway 'https://gateway.example' --machine 'MACHINE_UUID' --token 'WORKER_TOKEN'
```

macOS / Linux:

```sh
mkdir -p ~/.config/jian-remote && curl -fsS -o ~/.config/jian-remote/jian-remote.mjs 'https://gateway.example/jian-remote.mjs' && node ~/.config/jian-remote/jian-remote.mjs install --gateway 'https://gateway.example' --machine 'MACHINE_UUID' --token 'WORKER_TOKEN'
```

The one-liner puts the token in shell history. Clear history afterwards on a shared machine, or
install by hand with `--token-prompt` / `--token-stdin` instead. The worker script also lives at
`apps/gateway/bin/jian-remote.mjs` in the Jian source tree if you prefer to copy it yourself.

The worker executes Windows commands with PowerShell. The Windows credential directory and file
ACLs are restricted to the current account. To uninstall, delete the `Jian Remote` task in Task
Scheduler and remove `%USERPROFILE%\\.config\\jian-remote`.

Keep the worker script at its installed path: the OS service starts that file. The worker uses `/bin/sh -lc` on macOS/Linux and PowerShell on Windows, inherits the local user's
environment, and returns at most 50 KB each of stdout and stderr. Do not authorize profiles that should not have access to those local privileges.

## Agent use and revocation

The agent receives `list_remote_machines` and `run_remote_command` only when its profile has
`allowShell` enabled. The former returns only machines explicitly authorized for that profile;
the latter checks that authorization again before queuing each command. Results include exit
code, output, and timeout status. A machine must be online to accept work.

To revoke a profile, replace `allowedProfileIds` using the access endpoint above. To disconnect
and invalidate the machine token, delete the machine:

```sh
curl -fsS -X DELETE https://gateway.example/v1/remote/machines/MACHINE_UUID \
  -H "Authorization: Bearer $JIAN_GATEWAY_TOKEN"
```

Deleting a machine removes its queued tasks. This invalidates gateway access immediately;
remove the LaunchAgent/systemd unit and local config from the Mac to stop its polling process
and erase its stored credential. On macOS, run `launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.jian.remote.plist"` and remove that plist; on Linux, run `systemctl --user disable --now jian-remote.service` and remove `~/.config/systemd/user/jian-remote.service`. Then remove `~/.config/jian-remote` from the Mac to erase the credential and log.
