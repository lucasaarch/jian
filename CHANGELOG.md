# Changelog

Every release of Jian, newest first.

<!-- Generated from docs/releases by scripts/changelog.mjs. Edit the release note, then run `make changelog`. -->

## 0.8.4 — 2026-10-21

Jian Remote.app bundles Node @rpath shared libraries (libnode) so the macOS LaunchAgent no longer crashes immediately on Homebrew and similar installs.

### Remote Control

* **macOS libnode bundle:** materializing `Jian Remote.app` now copies not only `process.execPath` into `Contents/MacOS/Jian Remote`, but also the Node shared libraries it needs (`libnode.*.dylib` and companions such as ICU) into `Contents/lib`. Load commands are rewritten to `@rpath` when needed, quarantine is cleared, and the nested libs are ad-hoc signed. This fixes LaunchAgent crash loops of the form `Library not loaded: @rpath/libnode.*.dylib` on Homebrew Node (and similar nvm/fnm/official layouts that use `@rpath`). `install` / `update` / `configure` / `restart` refresh the bundle. See `docs/remote.md`.

### Upgrading

No new database migrations. After releasing, promote `@jian-ai/remote-control@0.8.4` on npm (or rely on gateway `/jian-remote.mjs` auto-update), then on each macOS worker:

```sh
npx @jian-ai/remote-control@0.8.4 update
# or, once the script is on disk:
jian-remote restart
```

Confirm `Contents/lib` contains `libnode.*.dylib` and `launchctl list | grep com.jian.remote` shows a live PID.

#### Workaround before 0.8.4 is promoted

If the LaunchAgent is crash-looping on a missing `libnode` dylib today, temporarily point ProgramArguments at your real Node binary (Login Items may show “Node.js Foundation” until you update):

```sh
NODE="$(command -v node)"
SCRIPT="$HOME/.config/jian-remote/jian-remote.mjs"
PLIST="$HOME/Library/LaunchAgents/com.jian.remote.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
# Keep AssociatedBundleIdentifiers; only swap ProgramArguments[0] to real node:
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $NODE" "$PLIST"
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/com.jian.remote"
```

After 0.8.4 is available, run `npx @jian-ai/remote-control@0.8.4 update` to restore the Jian Remote.app identity with bundled libs.

Stable installations can use the `latest` image tag or pin `0.8.4`.

## 0.8.3 — 2026-10-21

Fleet self-update to the gateway version, remote service CLI, shell cwd ENOENT fix, overlay cursor sprite, and full remote while the Mac is locked (no soft-block on Computer Use).

### Remote Control

* **Fleet auto-update:** connected workers reconcile to the gateway release on connect and about every five minutes — authenticated `/update` first (same stamped bytes as `/jian-remote.mjs`), then public `/jian-remote.mjs`, then `npm pack` for that version. Major.minor skew self-updates instead of refuse-looping. Failures back off (up to 30 minutes) and never wipe `config.json`. Prefer the gateway script when npm is not promoted yet so fleets do not bounce between package versions.
* **Service CLI:** `jian-remote version` (`--version` / `-V`), plus `stop` / `start` / `restart` for the LaunchAgent, systemd `--user` unit, or Windows Task Scheduler job, with clear English success/failure output. See `docs/remote.md`.
* **Single instance:** `~/.config/jian-remote/worker.pid` lock; start/restart/update always stop the previous worker and wait for it to exit before launching one process. Stale pollers whose in-memory version lags the installed script exit so KeepAlive reloads disk (fixes 0.8.1↔0.8.2 flip-flop after a gateway upgrade). LaunchAgent sets `PATH`, `HOME`, `WorkingDirectory`, and `ThrottleInterval`.
* **Remote shell ENOENT:** Node reports a missing **cwd** as `spawn /bin/sh ENOENT` even when `/bin/sh` exists (Computer Use kept working; `run_remote_command` did not). The worker now resolves cwd robustly, falls back to `$HOME` with an English note when the agent path is missing, keeps an absolute shell path, and rewrites spawn errors so they name the working directory. Covered by remote-control unit tests in `pnpm check`.
* **Overlay cursor:** macOS helper draws an embedded bitmap sprite (white fill, thick `#2880F8` stroke, soft blue glow) instead of the sharp geometric / cream-ink path. Linux and Windows overlays use the same white + `#2880F8` colors for parity. Click ripple and save/restore cursor behavior are unchanged.
* **Full remote while locked (macOS):** `uiState: locked` stays **advisory**. The gateway no longer soft-returns 409 for Computer Use when the screen is locked. The worker wakes the display (`caffeinate -u`) then **attempts** screenshot, click, type, key, scroll, and drag; clear errors only if the OS rejects the call. Shell and file tools keep working while the worker is online (same post-login Aqua session). FileVault / loginwindow before anyone signs in is still a different limit; lid-closed sleep is still true offline. See `docs/remote.md`.

### Upgrading

No new gateway migration in 0.8.3 (0.8.2 already added `remote_machines.ui_state`). After releasing, promote `@jian-ai/remote-control@0.8.3` on npm (or rely on gateway `/jian-remote.mjs` auto-update), then on each machine either wait for fleet self-update or run:

```sh
npx @jian-ai/remote-control@0.8.3 update
# or bounce the service after a binary refresh:
jian-remote restart
```

Confirm with `jian-remote version` and a short `run_remote_command` (shell) plus a Computer Use move. If Online flips between two worker versions in the log, `jian-remote stop` then `jian-remote start` clears a stray poller. On macOS, `update`/`restart` also refreshes the LaunchAgent so App Nap does not freeze polling while locked.

Stable installations can use the `latest` image tag or pin `0.8.3`.

## 0.8.2 — 2026-10-21

Computer Use polish across macOS/Linux/Windows, plus Mac lock stay-online (App Nap fix, uiState) so a locked screen is not mistaken for offline.

### Remote Control

* **Overlay cursor:** geometric white sharp pointer with a soft brand-blue glow (replaces the cream/ink wing). Idle still fades to very translucent; `end_session` removes it. See `docs/remote.md`.
* **Don’t steal the user mouse:** clicks, drags, and scrolls save the system cursor, hide it briefly while injecting at the target, then restore. `mouse_move` updates the Jian overlay only. Same policy on macOS, Linux, and Windows.
* **Smooth motion:** the overlay ease-out interpolates between positions (capped ~110 ms) instead of teleporting; clicks use a single `clickAt` helper round-trip.
* **Latency:** screenshot compress starts at longest side ≤ 1600 (skips a wasteful full-res pass); skips redundant session setup; slightly tighter default `wait` and helper sleeps. Observe→act unchanged.
* **Linux and Windows computer use:** workers advertise `computer-linux-v1` (X11 + `xdotool` + `ffmpeg` + Python overlay) or `computer-windows-v1` (SendInput + WinForms overlay). Gateway accepts those alongside `computer-macos-v1`. Pure Wayland without XWayland/`xdotool` is not advertised yet. Publish still builds only the macOS universal `computer-helper`; Linux/Windows helpers ship as source scripts in the npm package.
* **Mac lock stays online:** a password-locked Mac no longer looks offline when the worker is still polling. The LaunchAgent sets `ProcessType=Interactive` (avoids App Nap freezing the Node poll loop) and the worker holds idle `caffeinate`; machines report `uiState` (`unlocked` / `locked` / `display_asleep` / `unknown`). Computer Use while locked returns a clear error; shell and file tools still work. Display sleep is woken when a computer session starts. Lid-closed system sleep remains true offline. This is not ChatGPT-style locked Computer Use (no SecurityAgent plugin). See `docs/remote.md`.

### Upgrading

Gateway migration `0058_remote-ui-state` adds `remote_machines.ui_state`. After releasing, promote the staged `@jian-ai/remote-control@0.8.2` on npm, then run `npx @jian-ai/remote-control@0.8.2 update` (or `@latest`) on each worker so the new overlay/helpers, capability strings, and macOS LaunchAgent (`ProcessType=Interactive`) are picked up. Linux workers need `DISPLAY`, `xdotool`, `ffmpeg`, and `python3`; Windows needs an interactive desktop session.

Stable installations can use the `latest` image tag or pin `0.8.2`.

## 0.8.1 — 2026-10-21

Publish ships a prebuilt universal macOS computer-helper in the npm package so Computer Use works without Xcode Command Line Tools on the worker Mac.

### Remote Control

* **Prebuilt `computer-helper`:** Publish builds a universal (arm64 + x86_64) Swift helper on a macOS runner and includes it in the `@jian-ai/remote-control` tarball. `install` / `update` copy it under `~/Library/Application Support/Jian Remote/`; the worker prefers that binary over compiling with `swiftc`. Macs **without** Xcode Command Line Tools can run Computer Use and the Jian overlay. From a source checkout, `macos/build-helper.sh` (or first-use `swiftc`) still builds when CLT are present. See `docs/remote.md`.
* **Optional Developer ID:** when repository secrets for a Developer ID Application certificate (and optionally App Store Connect API keys for notarytool) are set, Publish can sign the helper; without them it ships ad-hoc signed, matching **Jian Remote.app** today. Full Developer ID + notarization of the app bundle remains a follow-up.
* **0.8.0 stayed source-only:** the `@jian-ai/remote-control@0.8.0` package contained Swift source and required `swiftc` on first probe/session. Workers on 0.8.0 without CLT did not advertise `computer-macos-v1`. Promote and `update` to **0.8.1** for the prebuilt helper.

### Upgrading

No new database migrations. After releasing, promote the staged `@jian-ai/remote-control@0.8.1` on npm, then run `npx @jian-ai/remote-control@0.8.1 update` (or `@latest`) on each macOS worker so the packaged binary is materialized.

Stable installations can use the `latest` image tag or pin `0.8.1`.

## 0.8.0 — 2026-10-21

Anthropic-style Remote Control computer use on macOS with a Jian overlay cursor, replacement of take_remote_screenshot by remote_computer, and always-on workspace shell (allowShell neutralized).

### Remote Control

* **Computer use (macOS):** agents authorized for a machine can drive the **primary display** with Anthropic-style actions via `remote_computer` — `screenshot`, clicks, `mouse_move`, `type`, `key`, `scroll`, `left_click_drag`, `wait`, and `end_session`. Coordinates are pixels in the scaled JPEG (`widthPx` × `heightPx`), using the same compress ladder as before (longest side ≤ 1920, ~280 KB binary). Typed worker jobs use `kind: 'computer'`; workers advertise capability `computer-macos-v1`. See `docs/remote.md`.
* **Jian overlay cursor:** while a computer-use session is open, a branded cream/ink wing pointer is visible on the Mac (not a generic red dot). After idle it stays visible but very translucent; `end_session` removes it entirely. Synthetic input and the overlay run under **Jian Remote.app** TCC (Screen Recording + Accessibility).
* **`take_remote_screenshot` removed:** screenshots go through `remote_computer` with `action: "screenshot"` (returns `mediaId` plus geometry). Builtin `remote-control` skill updated accordingly.
* **Machine ACL only:** remote shell and computer use are gated by each machine’s `allowedProfileIds`, not by the profile `allowShell` flag.

### Profiles and shell

* **`allowShell` neutralized:** workspace-confined shell and file tools (and the related builtin skills) are always available. The panel checkbox **Allow the terminal and files** is gone. The API field remains for older clients but is ignored for enforcement and defaults to true; existing profiles are set true by migration. Remote Control stays on machine access lists.

### Upgrading

Requires database migration `0057_remote-computer-use` (task `kind` / `payload`, machine `capabilities`, `allow_shell` default). After releasing, publish `@jian-ai/remote-control@0.8.0` and have macOS workers `update` so they ship the computer helper and advertise `computer-macos-v1`. Agents and prompts that called `take_remote_screenshot` must switch to `remote_computer`.

Stable installations can use the `latest` image tag or pin `0.8.0`.

## 0.7.2 — 2026-10-21

Jian Remote.app macOS Login Items identity, clearer install CLI success output, screenshot channel fit so Retina captures are no longer truncated grey JPEGs, and session objectives no longer auto-seed from casual chat.

### Remote Control

* **macOS app identity:** the LaunchAgent no longer runs the system `node` binary (shown as “Node.js Foundation” in Login Items / Background Items and for TCC). Install materializes a thin **Jian Remote.app** under `~/Library/Application Support/Jian Remote/` whose `Contents/MacOS/Jian Remote` is a copy of the install-time Node runtime (ad-hoc signed with bundle id `com.jian.remote` when `codesign` is available). The plist points at that executable and sets `AssociatedBundleIdentifiers`, so permissions attach to Jian instead of every Node process. **v1 is unsigned / ad-hoc** (npm distribute path; no Apple Developer account required); Developer ID notarization can layer on the same layout later. See `docs/remote.md`.
* **CLI success / status output:** `install`, `configure`, and `update` print a short success headline plus aligned facts (service, config path, gateway compatibility). Colors only on a TTY; respects `NO_COLOR` / `FORCE_COLOR`. Help and errors are lightly aligned for consistency.
* **Screenshot grey / truncation:** Retina JPEG base64 could hit the ~400 KB worker stdout channel mid-stream and decode as a corrupt image (often a solid grey lower half). `take_remote_screenshot` now scales and recompresses on the machine (longest side ≤ 1920, quality stepped down to about 280 KB binary) before base64. The gateway rejects incomplete JPEGs instead of storing them; the worker notes stdout truncation on stderr when the channel cap is hit. File pull/push still need to stay under the same ~300 KB binary budget.

### Agent loop

* **No auto-seeded objectives from chat:** casual and task-shaped owner or channel messages no longer open a durable session objective. An objective is set only with `/objective …`, `PUT /v1/profiles/{profileId}/sessions/{sessionId}/objective`, or the agent tool `set_session_objective`. A reply while the objective is `blocked` resumes the prior goal text instead of replacing it with chat. Channel `/objective` commands are parsed the same way as panel owner messages.

### Upgrading

No new database migrations. After releasing, promote the staged `@jian-ai/remote-control@0.7.2` on npm before relying on `@latest` installers. Existing macOS workers pick up **Jian Remote.app** and the LaunchAgent change on the next `update`, `configure`, or re-`install`.

Stable installations can use the `latest` image tag or pin `0.7.2`.

## 0.7.1 — 2026-10-21

Silent jian-remote install fix, configure for token or gateway changes, and Rotate credentials in the panel.

### Remote Control

* **Silent `jian-remote` on npm 0.7.0:** when `jian-remote` was invoked through npm’s symlink bin (`npx` or `npm install -g`), the CLI entry check compared unresolved paths and skipped the command body — so `install`, bare help, and related commands exited with no stdout or stderr. Install and help now always print a clear success or failure (and exit non-zero on failure).
* **`jian-remote configure`:** change the stored gateway URL and/or worker token (optional machine id) under `~/.config/jian-remote` and restart the existing OS service without wiping the LaunchAgent, systemd unit, or Windows task. Example: `jian-remote configure --token …` or `npx @jian-ai/remote-control@0.7.1 configure --gateway https://… --token …`.
* **Rotate credentials:** the Remote Control page offers **Rotate credentials** next to Save access. The gateway `POST /v1/remote/machines/:machineId/rotate` issues a new worker token (invalidates the old one) and the panel shows configure / install one-liners once, same secret-handling pattern as create-machine.
* **Docs:** macOS status and log checks (`launchctl`, plist path, `~/.config/jian-remote/worker.log`), plus configure and rotate guidance in `docs/remote.md`.

### Upgrading

No new database migrations. After releasing, promote the staged `@jian-ai/remote-control@0.7.1` on npm before relying on `@latest` installers. Machines that never got a working install under 0.7.0 should run install (or configure after rotate) again once 0.7.1 is available.

Stable installations can use the `latest` image tag or pin `0.7.1`.

## 0.7.0 — 2026-10-21

Remote Control as an npm package, worker auto-update and reliability, Listening quiet polls with session listeners UI, WhatsApp delivery and objective-continue fixes, and staged npm publish for releases.

### Remote Control

* **`@jian-ai/remote-control`:** the Windows / Mac / Linux worker ships as a public npm package (`jian-remote`), versioned with each Jian release. The panel shows npm / npx installers after you create a machine; no clone of the gateway repo is required. Install with `npx --yes @jian-ai/remote-control@… install …` or `npm install -g @jian-ai/remote-control@…`.
* **Update without the token again:** credentials stay in `~/.config/jian-remote/config.json`. Run `npx --yes @jian-ai/remote-control@latest update` (or `jian-remote update`) to refresh the worker to match the gateway and restart the service. Worker and gateway must share the same major.minor.
* **Panel and docs:** redesigned Remote Control page, online poll status, reboot guidance, screenshot and file tools, and the built-in `remote-control` skill.
* **Worker auto-update:** connected workers check the gateway for a newer script every five minutes, install it atomically, and restart. Polling and result delivery retry transient network failures with exponential backoff and jitter.
* **Large results and offline loops:** oversized result posts that used to return HTTP 413 and leave the worker effectively offline are fitted / handled so reconnect and delivery recover without manual intervention.
* **Publish flow:** the Publish workflow stages `@jian-ai/remote-control` at the release version with `npm stage publish` (Automation / stage-only `NPM_TOKEN`). A maintainer promotes the staged package on npmjs.com with 2FA. The gateway image and GitHub release still publish if the npm job fails.

### Listening

* **Quiet polls:** Listening polls wake a conversation only when observed state changes, so unchanged CI or pull-request state does not spam the session.
* **Subscription expiry and TTL:** subscriptions can expire; quiet / TTL behaviour keeps long-lived polls from drifting.
* **Session listeners UI:** the conversation surfaces active listeners so the owner can see what is watching without leaving the session.

### Channels

* **WhatsApp:** flushed commentary is no longer double-sent when the outbound path and the WhatsApp driver both delivered the same progress lines.

### Agent loop

* **Short session objectives:** objective text stays short so automatic continuation prompts carry a stable goal instead of dumping tool output, shell logs, or error stacks back into the next turn.

### Panel

* **Select in modals:** Select popups paint past modal footers instead of being clipped by overflow.

### Upgrading

Apply migrations `0054_remote_machines`, `0055_deliveries-one-per-run`, and `0056_subscription-expiry` when upgrading from 0.6.x.

Existing installations keep working without Remote Control until a machine is created and a worker is installed. After releasing, promote the staged `@jian-ai/remote-control@0.7.0` on npm before relying on `@latest` installers. Keep the profile workspace persistent so SSH keys, checkouts, and CLI authentication survive container recreation.

Stable installations can use the `latest` image tag or pin `0.7.0`.

## 0.6.0 — 2026-10-20

xAI/Grok, conversation subagents with shared workspace, durable session objectives, mid-run questions, GitHub MCP and Listening (poll by default), Gemini Live voice calls, and MCP/SSH reliability fixes.

### Providers

* **xAI / Grok:** configure xAI under **Providers** with an API key, or set `XAI_API_KEY` in the gateway environment. Model listing uses `https://api.x.ai/v1/models`; chat runs through the OpenAI-compatible path at that base URL.

### Agent loop

* **Context recovery:** when a tool result pushes a turn beyond the input window, Jian compacts it immediately instead of waiting for the usual spacing between checkpoints. If compaction still cannot fit the request, the gateway truncates oldest turn blocks until the current message fits, instead of hard-failing the run.
* **Scoped subagents:** each subagent starts from an explicit brief in a private session. Profile memories, activity and unrelated conversations are left out of its initial context. Subagents now share the principal profile workspace (`HOME` and checkouts) instead of a separate `_workers/…` home and detached Git worktrees.
* **Session objectives:** each conversation can carry a durable objective (`open`, `blocked`, `done`, or `cancelled`) that survives across turns. The owner can set or close it with `/objective …`, `/done`, or `/objective cancel`, or via `PUT /v1/profiles/{profileId}/sessions/{sessionId}/objective`. Substantial owner and channel messages seed an objective when none is open. The agent can set, complete, block, or cancel it with tools, and the current objective is injected into the prompt.
* **Automatic continuation:** while an objective stays `open`, a completed principal turn queues the next slice instead of waiting for the owner to say continue. Progress lines remain commentary. The agent calls `complete_session_objective` when the work is finished, or `block_session_objective` when it needs the owner. After 25 automatic continuations the gateway pauses as `blocked`.
* **Mid-run questions:** the agent can call `ask_user` with a prompt and optional choices. The run parks as `waiting` (not `completed`), so an open objective does not auto-continue until the owner answers. Answering from the panel or the same channel session resumes with a durable `ask-answer:` run; Telegram sends a one-time reply keyboard when choices are present.

### Panel and work

* **Subagents in conversations:** the conversation shows each subagent's status, transcript, tool activity and result. Completed work wakes the principal agent with a durable handoff.
* **Objective in the panel:** the conversation header shows the current session objective status and text (and a blocked note when the agent is waiting on the owner).
* **Work archive removed:** the task board, `/work` HTTP routes, and `list_tasks` / `list_task_subagents` tools are gone. Conversation subagents are the way to run scoped work.
* **Text-to-speech voice:** Model defaults › Text to speech offers a provider voice selector. Saved voice is used when generating speech unless a call requests one explicitly; “Default voice” keeps the provider default.

### GitHub

* **MCP presets:** the MCP form offers GitHub starters — remote HTTP + OAuth (`https://api.githubcopilot.com/mcp/`) and local stdio + PAT (`@modelcontextprotocol/server-github`). Getting-started and the coding-work skill point at GitHub MCP before shell `gh`.
* **Validation errors:** when GitHub MCP returns field-level validation details, the agent sees them instead of a bare `Validation Failed`. Prefer the remote HTTP + OAuth preset; the archived stdio server often strips those details upstream.
* **Listening (subscriptions):** the agent can create profile-scoped subscriptions that watch GitHub CI completion or pull-request merge/close. **Polling is the default** (about every 30 seconds); matching observations wake the chosen conversation with the subscription instruction. HMAC-verified webhooks remain optional for faster wake. Tools: `list_subscriptions`, `create_subscription`, `update_subscription`, `delete_subscription`.
* **Schedule times:** bare ISO datetimes and relative offsets (`+30s`, `+5m`, `+1h`, `+2d`) are accepted for `at` schedules; missing offsets are treated as UTC.

### Voice calls

* **Gemini Live in the gateway conversation:** choose a Gemini Live model under Model defaults › Voice calls, then use the phone control in the composer. The gateway mints a short-lived Gemini token; the browser streams microphone audio and plays the reply. On hang-up, the owner's spoken transcript is submitted through the ordinary session run path (not a separate summary endpoint). Voice selection is available for Live calls.
* **Model defaults:** Voice calls lists Gemini Live and OpenAI `gpt-live` / `gpt-realtime` models for API-key providers (not ChatGPT OAuth). Starting a call still requires Gemini Live; OpenAI Live sessions are not wired yet and return a clear conflict if selected.
* **Composer:** the phone control starts or ends a Live call; the microphone control remains the voice-note recorder.

### MCP and SSH

* **Reconnect on closed clients:** pre-send MCP transport deaths (closed client, disconnected SSE, stopped stdio) recreate the session with bounded retries and return a normal tool error instead of aborting the run as an uncertain outcome. Mid-flight mutating disconnects that may have applied still interrupt.
* **Definitive MCP refusals:** HTTP 4xx / validation failures from MCP tools are normal tool errors; the run continues. Uncertain mid-flight disconnects still interrupt.
* **Profile SSH for git:** Jian-managed profile SSH keys are wired for `git` (including GitHub host keys in `known_hosts`), so agents can push with the profile identity.

### Model defaults

* **Partial saves:** saving Model defaults validates only the roles that changed. A stale selection on an untouched role no longer blocks every other change with HTTP 409. Incompatible or unavailable model errors are shown with the gateway reason instead of a generic “session is busy” message.

### Dependencies

* **npm audit / Dependabot:** Next.js and related transitive advisories addressed for this release line; `pnpm audit` reports no known vulnerabilities after the bump.

### Upgrading

Apply migrations `0047_xai-provider`, `0048_drop-work-items`, `0049_session-objective`, `0050_run-waiting`, `0051_subscriptions`, `0052_model-default-voice`, and `0053_subscription-polling` when upgrading from 0.5.x.

`0048_drop-work-items` drops `work_items` and `runs.work_item_id`; existing task cards are not kept. Clients that still called `GET /v1/profiles/{profileId}/work*` must stop. Existing conversations start with no objective until one is set. Keep the profile workspace persistent so SSH keys, checkouts, and CLI authentication survive container recreation.

Stable installations can use the `latest` image tag or pin `0.6.0`.

## 0.6.0-rc.5 — 2026-10-19

Gemini Live voice calls in the panel, and MCP reconnect on closed clients.

### Voice calls

* **Gemini Live in the gateway conversation:** choose a Gemini Live model under Model defaults › Voice calls, then use the phone control in the composer. The gateway mints a short-lived Gemini token; the browser streams microphone audio and plays the reply. On hang-up, an English summary is written into the session history.
* **Model defaults:** Voice calls lists Gemini Live and OpenAI `gpt-live` / `gpt-realtime` models for API-key providers (not ChatGPT OAuth). Starting a call still requires Gemini Live; OpenAI Live sessions are not wired yet and return a clear conflict if selected.
* **Composer:** the phone control starts or ends a Live call; the microphone control remains the voice-note recorder.

### MCP

* **Reconnect on closed clients:** pre-send MCP transport deaths (closed client, disconnected SSE, stopped stdio) recreate the session with bounded retries and return a normal tool error instead of aborting the run as an uncertain outcome. Mid-flight mutating disconnects that may have applied still interrupt.

### Upgrading

No new migrations. This is a prerelease and does not move the `latest` image tag.

## 0.6.0-rc.4 — 2026-10-19

Mid-run owner questions, objective UI, GitHub MCP presets, and GitHub event subscriptions.

### Agent loop

* **Mid-run questions:** the agent can call `ask_user` with a prompt and optional choices. The run parks as `waiting` (not `completed`), so an open objective does not auto-continue until the owner answers. Answering from the panel or the same channel session resumes with a durable `ask-answer:` run; Telegram sends a one-time reply keyboard when choices are present.
* **Objective in the panel:** the conversation header shows the current session objective status and text (and a blocked note when the agent is waiting on the owner).

### GitHub

* **MCP presets:** the MCP form offers GitHub starters — remote HTTP + OAuth (`https://api.githubcopilot.com/mcp/`) and local stdio + PAT (`@modelcontextprotocol/server-github`). Getting-started and the coding-work skill point at GitHub MCP before shell `gh`.
* **Event subscriptions:** the agent can create profile-scoped subscriptions that listen for GitHub CI completion or pull-request merge/close. Matching webhooks (HMAC-verified) wake the chosen conversation with the subscription instruction. Tools: `list_subscriptions`, `create_subscription`, `update_subscription`, `delete_subscription`.

### Upgrading

Apply migrations `0050_run-waiting` (adds run status `waiting` and `runs.question`) and `0051_subscriptions` (adds `subscriptions` and `subscription_deliveries`). This is a prerelease and does not move the `latest` image tag.

## 0.6.0-rc.3 — 2026-10-19

Keep multi-step work running with durable session objectives and automatic turn continuation.

### Agent loop

* **Session objectives:** each conversation can carry a durable objective (`open`, `blocked`, `done`, or `cancelled`) that survives across turns. The owner can set or close it with `/objective …`, `/done`, or `/objective cancel`, or via `PUT /v1/profiles/{profileId}/sessions/{sessionId}/objective`. Substantial owner and channel messages seed an objective when none is open. The agent can set, complete, block, or cancel it with tools, and the current objective is injected into the prompt.
* **Automatic continuation:** while an objective stays `open`, a completed principal turn queues the next slice instead of waiting for the owner to say continue. Progress lines remain commentary. The agent calls `complete_session_objective` when the work is finished, or `block_session_objective` when it needs the owner. After 25 automatic continuations the gateway pauses as `blocked`.

### Upgrading

Apply migration `0049_session-objective` (adds `sessions.objective`). Existing conversations start with no objective. This is a prerelease and does not move the `latest` image tag.

## 0.6.0-rc.2 — 2026-10-19

Add xAI/Grok as a model provider and remove the Work archive.

### Providers

* **xAI / Grok:** configure xAI under **Providers** with an API key, or set `XAI_API_KEY` in the gateway environment. Model listing uses `https://api.x.ai/v1/models`; chat runs through the OpenAI-compatible path at that base URL.

### Panel and work

* **Work archive removed:** the read-only task board, `/work` HTTP routes, and `list_tasks` / `list_task_subagents` tools are gone. Conversation subagents remain the way to run scoped work, with the same private session, panel transcript and durable handoff.

### Upgrading

Apply migrations `0047_xai-provider` and `0048_drop-work-items`. The latter drops `work_items` and `runs.work_item_id`; existing task cards are not kept. Clients that still called `GET /v1/profiles/{profileId}/work*` must stop. This is a prerelease and does not move the `latest` image tag.

## 0.6.0-rc.1 — 2026-10-18

Run subagents inside conversations and compact oversized agent turns sooner.

### Agent loop

* **Context recovery:** when a tool result pushes a turn beyond the input window, Jian compacts it immediately instead of waiting for the usual spacing between checkpoints. The checkpoint can include work from the current turn while retaining the latest user request.
* **Scoped subagents:** each subagent starts from an explicit brief in a private session. Profile memories, activity and unrelated conversations are left out of its initial context.

### Panel and work

* **Subagents in conversations:** the conversation shows each subagent's status, transcript, tool activity and result. Completed work wakes the principal agent with a durable handoff.
* **Work archive:** existing task cards and worker histories remain available for reference. New work starts through conversation subagents; the old board no longer accepts task creation or updates.

### Upgrading

No database migration or new configuration is required. Existing task cards remain readable, and workers already queued for those cards can finish. Their cards can no longer be edited. Direct subagent worktrees remain on disk so detached commits are not lost; review their storage use until artifact handoff and cleanup are available. This is a prerelease and does not move the `latest` image tag.

## 0.5.1-rc.2 — 2026-10-01

Keep theme reveals aligned on pages with vertical scrolling.

### Panel

* **Theme reveals on scrolling pages:** the circular theme transition now calculates its origin and radius from the viewport captured by the browser, keeping the reveal anchored to the clicked control on pages with vertical scroll.

### Upgrading

No database migration or configuration change is required. This is a prerelease and does not move the `latest` image tag.

## 0.5.1-rc.1 — 2026-10-01

Keep the theme reveal animation smooth in Chrome.

### Panel

* **Smooth theme transitions in Chrome:** the circular theme reveal now declares its View Transition animation before the browser captures the new page, preventing the animation from stopping early or revealing the page all at once.

### Upgrading

No database migration or configuration change is required. This is a prerelease and does not move the `latest` image tag.

## 0.5.0 — 2026-10-01

Profile SSH key management, richer task workers, themes, release notices, and clearer loading states.

### SSH keys

* **Manage keys in Jian:** create, view, copy, and delete a profile's Ed25519 SSH keys from the panel. Agents can manage their own keys through built-in tools and the `ssh-keys` skill. Private keys stay in the profile workspace and are never returned by the API; the agent shell cannot run `ssh-keygen`.
* **OpenSSH-compatible private keys:** newly generated keys use OpenSSH's native private-key format and are validated against `ssh-keygen`. Existing public keys remain unchanged.

### Task workers

* **Profile context:** task workers use their parent profile's memories, conversations, skills, MCP servers, and tools while keeping a temporary task identity. They report progress through their assigned task but cannot create tasks or spawn more workers.
* **Repository access:** workers continue to use separate Git worktrees. Missing or inaccessible repositories now produce a clearer error, and task repositories must be Git roots inside the profile workspace.

### Panel

* **Light and dark themes:** switch themes from the sidebar footer. Dark remains the default and the choice persists in the browser. Theme changes use a circular reveal, and Storybook pages support theme switching and navigation.
* **Release notices:** the sidebar reports newer stable releases when GitHub provides them. The button opens their notes; Jian does not update itself, so apply a new image tag using your deployment method. If GitHub is unavailable, the panel keeps its normal release-note history.
* **Conventional loading states:** page and data loading use standard spinners, with consistent 32px full-page and 20px compact sizes. Thinking orbs remain reserved for active session processing.

### Upgrading

No database migration or new configuration is required. Keep the profile workspace persistent so SSH keys and CLI authentication survive container recreation. Stable installations can use the `latest` image tag or pin `0.5.0`.

## 0.5.0-rc.2 — 2026-10-01

Fix generated SSH private keys and use conventional spinners for panel loading states.

### SSH keys

* **OpenSSH-compatible private keys:** newly generated Ed25519 keys are now stored in OpenSSH's native private-key format. Existing public keys remain unchanged, and the generated private/public pair is validated against `ssh-keygen`.

### Panel loading

* **Conventional spinners:** page and data loading states now use standard spinners instead of thinking orbs. Thinking orbs remain reserved for the session chat, run progress and tool-call timeline where the agent is actively processing.
* **Consistent sizing:** full-page loading uses a 32px spinner and compact activity loading uses 20px.

### Upgrading

No database migration or configuration change is required. Existing keys created before this release should be regenerated so OpenSSH can use their private files. This is a prerelease and does not move the `latest` image tag.

## 0.5.0-rc.1 — 2026-10-01

Profile SSH key management, fuller task-worker context, light theme, and notices for newer releases.

### SSH keys

* **Manage keys in Jian:** create, view, copy, and delete a profile's Ed25519 SSH keys from the panel. Agents can manage their own keys through built-in tools and the `ssh-keys` skill. Private keys stay in the profile workspace and are never returned by the API; the agent shell cannot run `ssh-keygen`.

### Task workers

* **Profile context:** task workers now use their parent profile's memories, conversations, skills, MCP servers, and tools while keeping their task brief and temporary identity. They can report progress through their assigned task but cannot create tasks or spawn more workers.
* **Repository access:** workers continue to use separate Git worktrees for code. A repository path that is missing or inaccessible now produces a clearer error; task repositories must be Git roots inside the profile workspace.

### Panel

* **Light and dark themes:** switch themes from the sidebar footer. Dark remains the default; the choice persists in the browser. Theme changes use a circular reveal, and Storybook pages support theme switching and navigation.
* **Release notices:** when GitHub reports newer releases, the sidebar shows how many versions are available. Stable installations ignore prereleases; prerelease installations include them. The button opens the notes for those newer versions. Jian does not update itself: apply a new image tag using your deployment method. If GitHub is unavailable, the panel keeps its normal release-note history without an update count.

### Upgrading

No database migration or new configuration is required. Keep the profile workspace persistent so its SSH keys and CLI authentication survive container recreation. This is a prerelease; it does not move the `latest` image tag.

## 0.4.4 — 2026-09-30

The panel follows gateway changes without repeated database polling, and focus rings no longer distract from the interface.

### Live panel updates

* **Event-driven updates:** the gateway wakes profile event streams with PostgreSQL notifications after committed changes, including live run progress. The stream no longer queries the database every second while it waits.
* **Less redundant refresh work:** conversation history and task details now refresh from the existing event stream instead of maintaining their own polling timers. QR pairing, external OAuth status and stream reconnection keep their targeted retries.
* **Durable delivery:** event cursors, replay after reconnect and the existing heartbeat remain unchanged.

### Focus and controls

* **Quiet focus states:** dialogs, cards, inputs, selects, the composer, grouped fields and the audio player no longer draw strong focus outlines or rings. Keyboard focus remains available without the distracting border treatment.

### Upgrading

No migration or configuration change is required.

## 0.4.3 — 2026-09-29

GPT-6.1 Sol and model-specific higher reasoning levels for OpenAI.

### Models and reasoning

* **GPT-6.1 Sol:** ChatGPT-connected accounts can select it when their Codex catalog offers it. The gateway now requests the current Codex model catalog instead of an older client-version view.
* **Extra High and Maximum:** The model and conversation selectors offer `xhigh` and `max` only when the model's capabilities include them. For ChatGPT accounts, supported efforts come from that account's Codex catalog; API-key accounts use the public model catalog.
* **No false Ultracode option:** The Codex catalog's `ultra` level describes automatic task delegation, which the gateway does not implement. It remains unavailable in Jian rather than appearing as a misleading reasoning-only setting.

### Work panel

* Opening a task no longer highlights its title or Close task button. Keyboard navigation remains available inside the dialog.

### Task workers

* Workers now receive their own workspace and repository paths in their task context. When a report mentions another worker's path, the tools explain that it is isolated and direct the worker to its own worktree or the committed branch instead. The isolation boundary is unchanged.

### Upgrading

No migration or configuration change is required. Model availability still depends on the connected account or API key. The model list refreshes automatically; saved defaults remain unchanged.

## 0.4.2 — 2026-09-29

Task workers reuse their profile's Git SSH access, and completed task workspaces are reclaimed.

### Task workers

* **Git authentication:** a worker can use private keys and SSH configuration from its own agent profile without copying the keys into the worker workspace. Landlock-enabled hosts grant read-only access to that profile's `.ssh` directory; the existing no-Landlock caveat still applies elsewhere. Git commands also rewrite `https://bitbucket.org/` URLs to Bitbucket SSH, so existing HTTPS clone instructions can use the profile's SSH key. The profile must already have a usable key and trusted host configuration.
* **Workspace cleanup:** once a task is done and all of its workers have stopped, Jian removes their Git worktrees and temporary workspaces. Cleanup is retried after a restart. Active and blocked tasks keep their workspaces. Commit and push any worker changes before marking a task done: cleanup removes uncommitted files in those worktrees.

### Work panel

* Opening a task focuses its heading instead of highlighting the Close task button. The Activity loading orb is smaller and centered in its panel.

### Upgrading

No migration or configuration change is required. Existing completed tasks with leftover worker workspaces are cleaned up by the run queue.

## 0.4.1 — 2026-09-29

Task workers are easier to follow, and recoverable MCP lookup failures no longer stop a run.

### Agent workflows

* **Task worker reports:** when a worker finishes, its principal is resumed and its response is queued for delivery to the originating chat channel, including Telegram. The report no longer exists only in the gateway session.
* **Isolated repositories:** code tasks can name up to four repository roots in the agent workspace. Each worker receives its own Git worktrees under `repos/`, starting from committed `HEAD`, instead of sharing a writable checkout with the principal. Uncommitted changes are not copied and must be committed before a worktree is prepared.
* **Task details:** the board shows the repositories attached to a task.

### Diagnostics

* **MCP lookup failures:** errors from tools declared read-only are returned to the agent so it can recover or choose another path. Calls that may change external state still stop when their outcome is unknown; the run error now names the tool and the reason. This does not fix errors originating in an MCP server, such as a missing `Mcp-Param-owner` header.
* **Conversation history:** tool steps remain visible with an unanswered or failed run, and a temporary timeline fetch failure no longer clears steps already shown in the panel.

### Upgrading

The gateway adds a `repositories` column to existing tasks on startup. Existing tasks keep an empty repository list; no manual migration is needed.

## 0.4.0 — 2026-09-29

Conversations keep their context across runs, and new Work tasks start an executor automatically.

### Agent context

* **Continuous conversations:** new runs receive session messages since the last saved summary instead of a fixed set of 40 recent messages. Unanswered group messages remain part of that history. Relevant, sanitized tool inputs and results from earlier runs are also available as historical evidence, without repeating the calls.
* **Model-aware compaction:** Jian summarizes older conversation and tool context as the selected model's window fills, preserving the current request and recent work. Original messages remain stored. If context still cannot fit, the run reports the failure instead of silently dropping history.
* **Run limits:** the cumulative 500,000-token stop is removed. Each model call must still fit its model's context window; a 500-step backstop remains. Provider-reported usage continues to be recorded, and provider spending limits still apply.

### Work

* Creating a task now queues an executor subagent in the same transaction. Task guidance asks for enough context to act independently, including the objective, source references, current evidence, acceptance criteria, and next actions. The principal agent can continue orchestrating without duplicating the worker's execution.

### Upgrading

The gateway applies an additive session-summary cursor migration on startup. Existing messages and summaries are retained; no manual configuration is required.

## 0.3.0 — 2026-09-29

More reliable agent workflows, with optional Ponytail and Caveman support.

### Agent workflows

* **Work:** task workers can mark verified work done directly when an independent review is unnecessary. Work guidance now calls for task updates at meaningful checkpoints and before reporting completion, and recommends subagents for substantial independent tasks.
* **Jev:** action decisions can understand a recent, specific owner confirmation without treating older requests as blanket authorization. A held action remains a local decision instead of being misread as outside content. The daily token ceiling and its unused panel controls have been removed; individual Jev uses can still be switched off.
* **Tool results:** with Caveman mode on, large local command and file results preserve a useful beginning and outcome in their previews, with the complete result available as an artifact.

### Optional extensions

* **Ponytail:** built-in coding guidance can be switched off per agent, and its conversation mode can be changed with `/ponytail` commands.
* **Caveman:** built-in concise-response guidance is opt-in per conversation. The image includes a local Caveman proxy in record mode, disabled by default. Set `JIAN_CAVEMAN_ENABLED=true` to start it and route native OpenAI and Anthropic API-key calls through it. Subscription and other provider routes remain direct. The proxy address defaults to `http://127.0.0.1:8788` and can be overridden for an externally managed listener.

### Upgrading

The gateway applies the new conversation-mode migrations on startup. No action is needed unless you want to enable the Caveman proxy; leave `JIAN_CAVEMAN_ENABLED` unset or `false` to keep direct provider calls.

## 0.2.0 — 2026-09-29

Agent-managed work boards and isolated task subagents arrive in Jian.

### Features

* **Work:** agents can track tasks across chats on a durable, per-agent board, with status, progress notes, history and optional images. The gateway panel lets the owner inspect the board and each task's activity, but only the agent can create or change tasks.
* **Task subagents:** a principal agent can spawn anonymous workers for a task with their own identity, brief and private transcript. Workers can execute or review work, and their results are handed back to the principal agent for orchestration.

### Improvements and fixes

* **Work panel:** the board scrolls within the page, and task details open in an overlay with the worker transcript and tool activity.
* **Overview:** waits for usage data before displaying the page, avoiding a layout shift. Codex subscription usage is shown as a weekly window; Claude retains its five-hour and weekly windows.
* **Branding:** browser, Safari and installed-app icons use the Jian mark.

### Upgrading

The gateway applies the new work and subagent database migrations on startup. No manual configuration is required.

## 0.1.0 — 2026-09-29

Welcome to Jian.
