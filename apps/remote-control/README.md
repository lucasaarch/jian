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

## Configure

Change the stored gateway URL and/or worker token without a full reinstall (restarts the
existing OS service):

```sh
jian-remote configure --token WORKER_TOKEN
jian-remote configure --gateway https://gateway.example --token WORKER_TOKEN
```

## Compatibility

Worker and gateway must share the same major.minor. See [docs/remote.md](../../docs/remote.md).

Requires Node.js 24+. Published builds include a prebuilt macOS `computer-helper` for Computer
Use (no Xcode on the worker Mac). From source, run `macos/build-helper.sh` on a Mac, or let the
worker compile with `swiftc` when Command Line Tools are installed.

On macOS the LaunchAgent uses `ProcessType=Interactive` and an idle `caffeinate` so the worker
keeps polling while the screen is locked (App Nap must not freeze timers). Computer Use still
needs an unlocked session; a locked Mac stays **online** with `uiState: locked`. See
[docs/remote.md](../../docs/remote.md).
