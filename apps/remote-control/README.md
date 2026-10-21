# `@jian-ai/remote-control`

Jian Remote Control worker. Connects a Windows, macOS, or Linux computer to a Jian gateway
over outbound HTTPS polling.

## Install

```sh
npm install -g @jian-ai/remote-control
jian-remote install --gateway https://gateway.example --machine MACHINE_UUID --token WORKER_TOKEN
```

Or without a global install:

```sh
npx @jian-ai/remote-control@latest install \
  --gateway https://gateway.example \
  --machine MACHINE_UUID \
  --token WORKER_TOKEN
```

## Update

```sh
npx @jian-ai/remote-control@latest update
# or: jian-remote update [--version 0.6.0]
```

Reads `~/.config/jian-remote` (no token, machine id, or gateway flags), installs a compatible
build, and restarts the worker service.

## Version and service control

```sh
jian-remote version          # also --version / -V
jian-remote stop | start | restart
```

`start` / `restart` stop any previous worker before launching one process (LaunchAgent,
systemd --user, or Task Scheduler).

## Configure

Change the stored gateway URL and/or worker token without a full reinstall (restarts the
existing OS service):

```sh
jian-remote configure --token WORKER_TOKEN
jian-remote configure --gateway https://gateway.example --token WORKER_TOKEN
```

## Compatibility

Connected workers self-update to the gateway’s release (gateway `/update` script, npm
fallback) including major.minor skew, then restart the OS service. Manual `install` /
`update` still gate on `/health`. See [docs/remote.md](../../docs/remote.md).

Requires Node.js 24+. Computer Use works on macOS, Linux (X11 + `xdotool`/`ffmpeg`), and
Windows. Published builds include a prebuilt macOS `computer-helper` (no Xcode on the worker
Mac) plus Linux/Windows helper scripts. From source on a Mac, run `macos/build-helper.sh`, or
let the worker compile with `swiftc` when Command Line Tools are installed.

On macOS the LaunchAgent uses `ProcessType=Interactive` and an idle `caffeinate` so the worker
keeps polling while the screen is locked (App Nap must not freeze timers). Computer Use still
needs an unlocked session; a locked Mac stays **online** with `uiState: locked`. See
[docs/remote.md](../../docs/remote.md).
