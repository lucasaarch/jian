# `@jian-ai/remote-control`

Jian Remote Control worker. Connects a Windows, macOS, or Linux computer to a Jian gateway
over outbound HTTPS polling.

## Install

The Remote Control page of the panel shows this command with your values filled in:

```sh
npm install -g @jian-ai/remote-control && jian-remote install \
  --gateway https://gateway.example --machine MACHINE_UUID --token WORKER_TOKEN
```

## Update

The worker does not update itself on its own. Update it from the panel (**Update** on the
machine), ask an agent to (`update_remote_machine`), or run on the computer:

```sh
jian-remote update [--version 0.6.0]
```

It installs the gateway's release (or the one named) with `npm install -g`, then the new
release copies itself into `~/.config/jian-remote` and restarts the worker service
(`jian-remote reinstall`). The credentials stay as they are. Only a worker installed with npm
can be updated from the panel or by an agent.

## Version and service control

```sh
jian-remote version          # also --version / -V
jian-remote stop | start | restart
```

`start` / `restart` stop any previous worker before launching one process (LaunchAgent,
systemd `--user` or system unit, or Task Scheduler). On Linux headless/root hosts without a
user bus, `install` falls back to a system unit (or pass `install --system`).

## Configure

Change the stored gateway URL and/or worker token without a full reinstall (restarts the
existing OS service):

```sh
jian-remote configure --token WORKER_TOKEN
jian-remote configure --gateway https://gateway.example --token WORKER_TOKEN
```

## Compatibility

A worker must share its gateway's major.minor to serve agents. One on another release still
connects, shows **Update needed** in the panel, and takes no task but its update. `install`
refuses a mismatched release up front.

Requires Node.js 24+. Computer Use works on macOS, Linux (X11 + `xdotool`/`ffmpeg`), and
Windows. Published builds include a universal macOS `computer-helper`, built from the Rust crate
in `packages/remote-core/native`, plus Linux/Windows helper scripts. From source on a Mac, build
it with `pnpm --filter @jian/remote-core helper:macos` (rustup with both Apple targets).

On macOS the LaunchAgent uses `ProcessType=Interactive` and an idle `caffeinate` so the worker
keeps polling while the screen is locked (App Nap must not freeze timers). A locked Mac stays
**online** (`uiState: locked` is advisory): the worker wakes the display and attempts
Computer Use; it does not soft-refuse.
