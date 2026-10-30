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

Requires Node.js 24+. Computer Use works on macOS, Linux under X11, and Windows, through one
native `computer-helper` per platform built from the Rust crate in `packages/remote-core/native`
(`build-macos.sh`, `build-linux.sh`, `build-windows.sh` there); published builds ship all of
them. From source, build them with `pnpm --filter @jian/remote-core helper:macos` (on a Mac),
`helper:linux` (any host with rustup) or `helper:windows` (Windows, or cargo-xwin elsewhere).

### Wayland: not supported yet, contributions welcome

On a Wayland session the Linux helper still runs through XWayland, so it only sees and drives
apps that run under XWayland; native Wayland windows are out of its reach. Headless Linux hosts
(a VPS with Xvfb) are X11 and unaffected.

Wayland deliberately forbids what the X11 backend relies on: reading the whole screen,
injecting input anywhere and keeping a window above all others. A Wayland backend needs a
different route for each:

| | GNOME (46+) and KDE (6+) | wlroots (Sway, Hyprland, …) |
|---|---|---|
| Screenshot | ScreenCast portal over PipeWire; asks the user once, then a restore token | `wlr-screencopy`, no prompt |
| Input | RemoteDesktop portal with libei (`ConnectToEIS`); asks once, restore token | `virtual-pointer` and `virtual-keyboard`, no prompt |
| Jian pointer | KDE: `wlr-layer-shell`. GNOME: impossible without a Shell extension, so none | `wlr-layer-shell` |

`/dev/uinput` works on any compositor for input, but needs a udev rule or group membership and
makes absolute positioning awkward.

In Rust the pieces exist: `ashpd` for the portals, `pipewire` for the frames, `reis` for libei
and `smithay-client-toolkit` for layer-shell. The backend would sit beside the X11 one under
`packages/remote-core/native/src/platform/linux/`, chosen at start from `XDG_SESSION_TYPE`
and `WAYLAND_DISPLAY`, behind the same `Platform` and `Pointer` traits. The wlroots path can be
tested in a container with headless Sway; the portal path needs a real GNOME or KDE session,
which is why it is open for someone who runs one.

On macOS the LaunchAgent uses `ProcessType=Interactive` and an idle `caffeinate` so the worker
keeps polling while the screen is locked (App Nap must not freeze timers). A locked Mac stays
**online** (`uiState: locked` is advisory): the worker wakes the display and attempts
Computer Use; it does not soft-refuse.
