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

The gateway owner must provide the machine UUID and its one-time worker token to the Mac owner
through a secure channel. Do not paste the token into a shell command or commit it to a file.

## Install the worker

Install Node.js 24+ on the Mac, Linux host, or Windows computer. Obtain
`apps/gateway/remote/jian-remote.mjs` from the same Jian release as the gateway, then run the
installer from its containing directory. It reads the worker token from a hidden interactive
prompt (`--token-prompt`) or standard input (`--token-stdin`), stores it with owner-only
permissions, and installs a per-user LaunchAgent on macOS, a systemd service on Linux, or a
Task Scheduler logon task on Windows. The Windows task runs only in the current user's session.

For Windows, open PowerShell in the directory containing the script:

```powershell
node .\\jian-remote.mjs install --gateway https://gateway.example --machine MACHINE_UUID --token-prompt
```

The worker executes Windows commands with PowerShell. The Windows credential directory and file
ACLs are restricted to the current account. To uninstall, delete the `Jian Remote` task in Task
Scheduler and remove `%USERPROFILE%\\.config\\jian-remote`.

On macOS/Linux, standard input avoids putting the token in shell history:

```sh
read -r -s -p 'Worker token: ' JIAN_REMOTE_TOKEN
printf '\\n'
printf '%s' "$JIAN_REMOTE_TOKEN" | node ./jian-remote.mjs install \\
  --gateway https://gateway.example --machine MACHINE_UUID --token-stdin
unset JIAN_REMOTE_TOKEN
```

The installer retains the existing per-user LaunchAgent or systemd setup; unsupported platforms
can run the `run` command manually.

```sh
read -r -s -p 'Worker token: ' JIAN_REMOTE_TOKEN
printf '\n'
printf '%s' "$JIAN_REMOTE_TOKEN" | node ./jian-remote.mjs install \
  --gateway https://gateway.example --machine MACHINE_UUID --token-stdin
unset JIAN_REMOTE_TOKEN
```

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
