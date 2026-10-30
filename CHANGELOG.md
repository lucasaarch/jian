# Changelog

Every release of Jian, newest first.

<!-- Generated from docs/releases by scripts/changelog.mjs. Edit the release note, then run `make changelog`. -->

## 1.1.2 — 2026-10-30

The desktop app for macOS, Windows and Linux, and the 1.1 worker on npm, which 1.1.1 could not build, on the release page installed apps update from.

### The desktop app

* **Every system, on one release:** 1.1.1's builds could not start, as the runners its Computer Use helper was built on are being retired. This release builds them on current ones, so it carries the app for macOS (Apple silicon and Intel), Windows (x64 and ARM) and Linux (x64 and ARM), with the Windows and Linux packaging fixes 1.1.1 brought, and `@jian-ai/remote-control` reaches npm with it.

Everything 1.1.0 brought is in this release; its note says what changed and what upgrading needs, the one manual update of each machine's worker included.

### Upgrading

* From 1.0, read the 1.1.0 note first: migrations 0079 and 0080 run at startup, and each machine's worker needs one update by hand.
* From 1.1.0 or 1.1.1, recreate the gateway and web containers with the 1.1.2 images, or follow the `latest` tags. A 1.1.0 worker keeps working; Update under Machines brings it to 1.1.2.
* The desktop app on 1.1.0 updates itself to this release.

## 1.1.1 — 2026-10-30

The desktop app for Windows and Linux, which 1.1.0's packaging could not build, and with it the 1.1.0 release page and its installers for every system.

### The desktop app

* **Windows and Linux builds:** the app packages on Windows, where the local gateway's build now runs pnpm and npm as Windows expects, and on Linux, where it installs as `jian`. With every build done, the release carries the installers for macOS, Windows and Linux, and installed apps update from it.

Everything 1.1.0 brought is in this release; its note says what changed and what upgrading needs, the one manual update of each machine's worker included.

### Upgrading

* From 1.0, read the 1.1.0 note first: migrations 0079 and 0080 run at startup, and each machine's worker needs one update by hand.
* From 1.1.0, recreate the gateway and web containers with the 1.1.1 images, or follow the `latest` tags. `@jian-ai/remote-control@1.1.1` brings nothing new to a worker; 1.1.0 workers keep working.

## 1.1.0 — 2026-10-30

Jian is a desktop app for macOS, Windows and Linux, with a gateway of its own that works the moment it is installed, and the web panel is the same app in a browser. Computers are Machines, and the app's computer joins every gateway it connects to. API channels speak OpenAI, and the Overview shows Claude's limits.

### The desktop app

* **Jian on your computer:** an app for macOS, Windows and Linux, with no sign-in. It runs a gateway of its own, so it works as soon as it is installed. Its gateway is for chats: it has no channels, since the computer is not always on.
* **Your gateways too:** connect one that runs on a server by its address and host token. Switch between them from the status bar; a gateway that is away shows what was kept of it and catches up once it answers.
* **It keeps going in the background:** closing the window keeps the app in the tray, and it can open at login. A reply in a chat you are not reading arrives as a system notification, which opens that chat.
* **Its own title bar:** the chats run up to the window's top, with back and forward beside the sidebar's buttons. ⌘⇧P opens the command palette, ⌘K searches the chats, ⌘N starts one and ⌘, opens the settings.
* **It updates itself:** new releases download in the background and install when you quit, or at once with Restart to update. A sheet says what is new, shows the download and names what went wrong when something does. On Linux the AppImage updates itself; a `.deb` offers the download.

### The panel

* **A Welcome:** the first run opens on an animated introduction that connects a model provider and shapes the first agent, in the app and on the web, and picks up where it was left.
* **One app, in the browser and on the desktop:** the web panel is the desktop app's chats, sidebar and settings. A phone opens on the list of chats, and a chat, a page or the settings fill the screen over it.
* **The sidebar:** New chat, then the agent's Overview, Schedules and Customize, then its projects, conversations and each channel's chats. The agent picker sits at its foot.
* **Pages in the chat's place:** Overview, Schedules, Customize (Skills, Memories and Channels) and the agent's settings open where the conversation was. Escape goes back to the chat you were in. A count on Customize says how many contacts are waiting for approval.
* **Settings in one place:** providers, model defaults, integrations, SSH keys and machines, each a line with Configure for the rest, and the app's own general and appearance settings.
* **Old addresses still work:** links to the former pages, and the ones push notifications open, lead to their new places.
* **Boundaries:** an agent's identity has rules it keeps whatever it is asked, one to a line.
* **Schedules:** dates and times are picked from a calendar and lists of hours and minutes, and the conversation a schedule answers in is searched.

### Conversations

* **The Inspector runs to the window's top:** a pull request or an issue keeps its heading in place while its description, checks, changes and reviews scroll. Its options wrap the diffs' lines, fold everything at once, read it again, open it on GitHub or copy its link.
* **A subagent's Inspector** shows its kind and how long it has worked, then what it did and said.
* **A conversation has no header:** its controls float in its corners.

### GitHub

* **Clone and push with the App:** a new `github_git` tool clones, fetches, pulls and pushes GitHub repositories with the Jian GitHub App's token, in the gateway's workspace or on the machine a conversation targets. A private repository no longer needs an SSH key registered on GitHub. The token is lent to that one git command: it never lands in `.git/config` or the remote's address, and it is masked in what the agent reads. A checkout whose origin is an SSH address goes through it too.
* **The same reach as the API tools:** a project's conversation reaches its repository alone; any other conversation reaches every repository the owner granted the App. A repository outside that is refused, saying why.
* **Under the conversation's protection:** cloning, fetching and pulling act on the machine; pushing acts on GitHub, so on Ask first it waits for approval. The guardrail refuses force-pushing over `main`, `master` or `trunk`, through the tool or the shell.
* SSH keys under Settings keep working for git as before.

### Machines

* **Remote control is Machines:** the same computers, under a plainer name, in the panel and in what agents read.
* **The app's computer joins in:** on every server gateway it connects to, the desktop app registers its computer as a machine, named as the computer is and with its system and architecture, without asking. A switch in Machines stops agents from using it; the record stays.
* **What each machine is:** a machine shows its system with its version, such as macOS 27.2, and its architecture.
* **Updates on request:** a worker no longer updates itself. Update in Machines, an agent (`update_remote_machine`) or `jian-remote update` on the computer asks for it. A worker on another release than its gateway still connects, and takes only its update until it matches.
* **One install command:** adding a machine and rotating its credentials show the same command, which installs or updates `jian-remote` and connects it. `jian-remote status` and `jian-remote logs` say how the worker stands and what it did.
* **One Computer Use helper for every system:** macOS, Linux (X11) and Windows share one Rust helper that draws the same Jian pointer. The worker no longer needs ffmpeg, xdotool, Python or PowerShell.

### API channels

* **OpenAI-compatible:** each API channel answers at `/v1/channels/{channelId}/openai`, so a client built for OpenAI's API, a chat UI or an automation tool, talks to the agent by pointing its base URL there and using the channel's token as its API key. `GET /models` lists `default` and every model the gateway's providers offer; `POST /chat/completions` answers as OpenAI does, whole or streamed. Fields such a client sends that Jian has no use for, like `temperature` or `tools`, are accepted and left aside; only text is read from messages.
* **One conversation per chat:** `metadata.chat_id` names the conversation a request belongs to. Without it, the conversation is told apart by its opening system and user messages, so a client that sends the whole history each turn stays in one conversation. Only the newest user message reaches the agent, which keeps the history itself. A request sent again returns the same answer instead of asking twice.
* **Protection, model and effort:** ingress and chat completions take `protection` (`ask` or `auto`), `model` (an id the providers list, or `default`) and `effort`, and the conversation keeps them for the turns after. A conversation an API caller opens starts on Auto; `full` is refused. Without a model, it follows Model defaults, as `default` brings it back to.
* **Waiting:** an answer that waits on an approval or a question says so in its text, and the approval is decided in Jian. A completion that is not streamed waits up to ten minutes for the agent; past that, the run goes on and the request is told it is still working.

### Overview

* **Claude's limits:** the five-hour and weekly windows of a Claude subscription show beside Codex's. Anthropic's usage endpoint refuses a `claude setup-token` credential, so they are read from the answers Claude's runs get, and show after the first run since the gateway started.
* **When nobody may approve:** a chat whose contact cannot approve tells the agent it is a protection setting, not a missing key, and that Auto or letting the contact approve would let it act.

### API

* **Machines:** a machine carries `system`; a remote shell task can carry environment variables the worker masks in its output, offered to workers that advertise `shell-secret-env-v1`; `POST /v1/remote/machines` takes `platform` and `system`; `POST /v1/remote/machines/{machineId}/update` updates its worker; workers report `x-jian-system` and `x-jian-remote-version`.
* **Ingress:** `POST /v1/ingress/{channelId}` takes `protection`, `model` and `effort`.
* **OpenAI:** `GET /v1/channels/{channelId}/openai/models` and `POST /v1/channels/{channelId}/openai/chat/completions`, authorized by the channel's token as `Authorization: Bearer` or as `x-jian-channel-token`. Errors take OpenAI's shape.
* **Health:** `/health` says `mode`: `server`, or `local` for a desktop app's own gateway.
* **Removed:** `/jian-remote.mjs` and `/v1/remote/worker/{machineId}/update`. Workers are installed and updated with npm.

Regenerate clients from `/openapi.json`.

### Upgrading

* **Migrations 0079 and 0080 run at startup.** They record each worker's release and whether it updates on request, and each machine's system.
* **Update each machine's worker once, by hand.** A 1.0 worker updated itself from the gateway, which no longer serves it. Rotate the machine's credentials under Machines and run the command it shows on that computer: it installs the 1.1.0 worker and connects it again. From then on, Update in Machines does it. `github_git` needs a 1.1.0 worker on a machine.
* **API conversations start on Auto from now on,** where they started on Ask first. Ones that already exist keep the protection they have.
* **The web host waits longer:** up to eleven minutes for the gateway's first byte, where it gave up after five, so a long chat completion reaches the client through it.
* Recreate the gateway and web containers with the 1.1.0 images, or follow the `latest` tags. The desktop app is on the release's page, for macOS (Apple silicon and Intel), Windows (x64 and ARM) and Linux (x64 and ARM, AppImage and `.deb`). Windows builds are not signed yet: Windows warns before the first run.

## 1.0.5 — 2026-10-30

Conversations on Auto act unattended behind a guardrail that refuses only the catastrophic, schedules can open a new chat each time they run and pick any conversation from a searchable list, chats rise to the top with an unread mark, and the agent's answers reach the panel and the owner's devices as notifications.

### Protection

* **Auto:** a third protection mode, beside Ask first and Full access. An action runs without waiting for anyone, unless the guardrail finds it catastrophic: destroying data, databases, infrastructure or backups wholesale, deleting or overwriting whole systems or home directories, changing or deleting every row of a table, or putting passwords, tokens and keys where they leak. Fixed rules catch the plainest cases (`rm -rf /`, `DROP DATABASE`, a `DELETE` or `UPDATE` without `WHERE`, `terraform destroy`, deleting volumes or backups, printing `.env` files, private keys or the environment); they read the commands an agent runs and what it hands a service, not the code it writes into files. Then Jev judges, where it is set up, under a new **Guardrail** use; without Jev, the conversation's own model does, at its lowest effort. A refused action goes back to the agent as a refusal and the run carries on. When no judge can answer, only the fixed rules apply. Subagents and a channel's contacts act under Auto as the conversation does.

### Schedules

* **A new chat each time:** a schedule can name no conversation. Each time it runs it opens a chat in Chats, named after the schedule and set to Auto, since nobody is there to approve at the hour it runs; the answer stays in the panel. It is the first choice, and the default for a new schedule.
* **Any conversation:** the conversation picker lists every chat, WhatsApp and Telegram contact and group, and API conversation, grouped in that order with each provider's mark, alphabetical within each group, and searchable. Chats are listed by their titles; they used to all read "Gateway".
* **Learning is not a conversation:** the agent's look back at its work runs in the background and is no longer listed among conversations or offered to schedules. Neither are a subagent's tasks or conversations between agents.

### Chats

* **The latest first:** a conversation rises to the top of its list when something is said in it, and in Chats so does the group, General or a repository, it belongs to.
* **Unread:** a chat the agent wrote in since you last read it shows a dot and its name in bold, on every device: the gateway keeps when each chat was read. The chat on screen is read as it arrives.
* **Notices in the panel:** when the agent writes in a chat you are not reading, a notice says so wherever you are in the panel, with a button that opens the chat.

### Notifications

* **On your devices:** the bell beside the new chat button turns on notifications for the device, through its browser's push service. When the agent answers, asks something, or fails in a chat, the device shows it, and tapping it opens the chat. Nothing is sent about a chat you are reading at that moment. On an iPhone, add Jian to the Home Screen first; push needs the panel served over HTTPS. A device with notifications on gets them from its system instead of the in-panel notice.

### API

* **Schedules:** `sessionId` may be `null`, for a new chat each run. A schedule into a look back or a subagent's task is refused with `400`.
* **Sessions:** a session carries `readAt`, and `POST /v1/profiles/{profileId}/sessions/{sessionId}/read` marks it read. `GET /v1/profiles/{profileId}/sessions` no longer lists learning or task sessions.
* **Protection:** `protection` takes `auto`.
* **Push:** `GET /v1/push/key`, `PUT /v1/push/subscriptions` and `POST /v1/push/subscriptions/remove`.
* **Decisions:** the uses carry `guardrail`.

Regenerate clients from `/openapi.json`.

### Upgrading

* **Migration 0078 runs at startup.** It lets a schedule name no conversation, adds when each chat was read (every existing conversation counts as read), adds the table of subscribed devices, and accepts `auto` as a protection mode.
* The gateway makes its push keys on first use and keeps them in the installation's vault. With `JIAN_PUBLIC_URL` set to an `https://` address, push services are given it as the sender.
* Recreate the gateway and web containers with the 1.0.5 images, or follow the `latest` tags. Promote `@jian-ai/remote-control@1.0.5` on npm, or rely on the gateway's `/jian-remote.mjs` auto-update; it has no changes of its own.

## 1.0.4 — 2026-10-30

The Inspector reads a pull request in one view of folding sections instead of tabs, each review opens on GitHub where it was written, and Fix merge conflicts is offered in every conversation, in place of both Merge and the line about the conflict.

### Pull requests

* **One view, in sections:** the tabs from 1.0.3 give way to a single scroll. **Description**, **Checks**, **Changes** and **Reviews** follow one another, divided by a rule, and each folds under its heading with a click. A folded section still shows what it holds: how many checks passed out of how many and whether any failed, how many files changed, how many reviews there are.
* **Reviews open on GitHub:** the activity timeline is gone. Reviews are listed as before, who reviewed, their verdict and when, and each one opens the review itself on GitHub in a new tab, where everything the reviewer wrote is read.
* **Fix merge conflicts everywhere:** when a branch has conflicts, **Fix merge conflicts** takes the place of Merge and of the line saying the branch has conflicts. It is offered in every conversation now, WhatsApp and Telegram included: a run asked for from the Inspector shows in the panel and is never delivered on the channel, so the contact does not receive it. While the agent is already answering that contact, the request waits: it would join that answer and reach them, so the gateway asks to try again once the agent has finished. Merging itself stays with the panel's own chats.

### API

* **Pull requests** read from `GET /v1/integrations/github/pulls/{owner}/{repo}/{number}` no longer carry `comments`, and their reviews no longer carry `body`; both arrived in 1.0.3. Each review in `reviews.latest` carries `url`, its page on GitHub, when GitHub gives one. Regenerate clients from `/openapi.json`.
* **`POST /v1/profiles/{profileId}/sessions/{sessionId}/github/fix-conflicts`** accepts any conversation. It answers `409` only for a channel's conversation whose agent is answering at that moment.

### Upgrading

No migrations and nothing to configure. Recreate the gateway and web containers with the 1.0.4 images, or follow the `latest` tags. Promote `@jian-ai/remote-control@1.0.4` on npm, or rely on the gateway's `/jian-remote.mjs` auto-update; it has no changes of its own.

## 1.0.3 — 2026-10-30

The Inspector reads a pull request in tabs (description, checks, changes and an activity timeline), refreshes on demand with the conversation's references following it, and offers Fix merge conflicts in Merge's place, which starts the agent without a message in the chat.

### Pull requests

* **Tabs in the Inspector:** a pull request's content is split into **Description**, **Checks**, **Changes** and **Activity**, under its header. The Checks tab shows whether they pass, fail or are still running, and how many passed out of how many (`4/5`); Changes shows how many files changed; Activity is a timeline of reviews and comments, oldest first, with what each reviewer and commenter wrote.
* **Fix merge conflicts:** when a branch has conflicts with its base, **Fix merge conflicts** takes the place of Merge. It starts the chat's agent on resolving them, bringing the base in, settling each conflict, running the checks that cover it and pushing the branch. The request is the gateway's own note, read by the agent and kept out of the conversation, which shows the agent's work and its answer. As with Merge, it is offered in the panel's own chats only; in a WhatsApp or Telegram conversation the agent's work would reach the contact.
* **Refresh:** a button beside the Inspector's close button reads the pull request again from GitHub. Whatever the Inspector reads, from a refresh, from its regular reads of an open pull request or from a merge, is what the pull request's references in the conversation show at once.
* **People and links:** authors, assignees, reviewers and commenters are their GitHub names linked to their profiles, without a picture. **Open on GitHub** left the header: a mark beside the item's name in the Inspector's bar opens it on GitHub in a new tab.

### API

* **`POST /v1/profiles/{profileId}/sessions/{sessionId}/github/fix-conflicts`** takes a pull request's `owner`, `repo` and `number` and answers `202` with the run it queued. It answers `409` for a conversation that is not one of the panel's chats.
* **Pull requests** read from `GET /v1/integrations/github/pulls/{owner}/{repo}/{number}` now carry `comments`, the last thirty of their conversation, and each review in `reviews.latest` carries the `body` its reviewer wrote, when there is one. Regenerate clients from `/openapi.json`.

### Upgrading

No migrations and nothing to configure. Recreate the gateway and web containers with the 1.0.3 images, or follow the `latest` tags. Promote `@jian-ai/remote-control@1.0.3` on npm, or rely on the gateway's `/jian-remote.mjs` auto-update; it has no changes of its own.

## 1.0.2 — 2026-10-30

Pull requests read as references in the conversation and show a merge the moment it happens, the Inspector runs the full height of the pane, a failed turn is a quiet card with Retry above the composer, listeners join the objective as a badge you can stop from, and a new GitHub App no longer carries the installation's address in its name.

### Pull requests

* **References in the text:** a link to a pull request or an issue reads as GitHub writes one, its mark coloured by where it stands (open, draft, merged, closed) followed by its number. The repository, the title and the state are a hover away, and clicking still opens it in the Inspector.
* **A merge shows at once:** GitHub can still answer open for a moment after a merge, and that answer was kept for half a minute. A pull request merged from the panel now reads as merged right away, in the Inspector and in every reference to it, and in other open tabs too. A pull request merged elsewhere, by the agent or on GitHub, shows as merged within about thirty seconds: open ones are read again every thirty seconds in the conversation and every fifteen in the Inspector.
* **Loading:** while GitHub answers, the Inspector shows its own shape, the title, state, branches, actions and description, instead of a line of text.

### Panel

* **The Inspector runs the pane's height:** the panel beside a conversation, for a pull request or a subagent, starts at the top of the pane. The conversation's header covers only the conversation.
* **Errors above the composer:** a turn that failed, was interrupted or was cancelled is a card above the composer with the reason the gateway kept and a button to close it. In the panel's own chats, **Retry** runs the failed turn again; the note that tells the agent to carry on stays out of the conversation and asks it to check what the failed turn already did before repeating anything. A history that cannot be loaded uses the same card, with **Try again**.
* **Listeners as a badge:** a conversation's listeners left the header. They are a **Listening** badge beside the objective's, and its list shows what each one watches, how it stands, when it looks next and when it expires. The cross beside a listener stops it; it appears on hover, and always on a touch screen. A stopped listener stays in the agent's list, turned off.
* **The objective's popover** keeps to a readable width instead of running across the screen.
* **The history's spinner** sits in the middle of the conversation while it loads.

### GitHub

* **App name:** a GitHub App registered from now on is named `Jian - ` and a random eight-character hash. It used to include the installation's address, which GitHub shows on the App's public page. An App already registered keeps its name; rename it in its settings on GitHub if you like. The App's homepage link still points at the panel.

### API

* **Continuing a run:** the note `POST /v1/profiles/{profileId}/runs/{runId}/continue` writes is now marked as a resume note, like the one that resumes a pause. The agent reads it as before; message lists still return it, with `purpose: "resume"`, and the panel no longer shows it.

### Upgrading

No migrations and nothing to configure. Recreate the gateway and web containers with the 1.0.2 images, or follow the `latest` tags. Promote `@jian-ai/remote-control@1.0.2` on npm, or rely on the gateway's `/jian-remote.mjs` auto-update; it has no changes of its own.

## 1.0.1 — 2026-10-29

A conversation reads in the order its turn happened, with each tool under the line that announced it, an open objective's automatic nudges no longer show as your messages, and the objective moves from the header to a badge beside where the chat runs.

### Panel

* **Tools in the order they happened:** a turn's tools used to sit together above its first line, while everything else it said piled up below, so a long turn of edits and commands read out of order. Each tool now follows the last thing the agent said before it began, with its own Thought Line and file diffs, so the work appears as it is announced. While the turn runs, the working line stays at the end of the conversation with only the tools since its last line, and its clock counts from there.
* **The objective as a badge:** a conversation's objective left the header. It is a badge at the end of the composer's project and machine row, or of a channel conversation's toolbar, saying whether it is open, blocked, done or cancelled. Clicking it shows the whole goal and, when blocked, why. A conversation with neither keeps the badge in its header.

### Objectives

* **The nudge to carry on is out of sight:** while an objective is open, the gateway queues the next turn with a note telling the agent to continue. That note was stored as an ordinary message, so the panel showed it as if you had sent it, and the chat list previewed it. It is now marked as the gateway's own note, like the one that resumes a pause: the agent still reads it, and the conversation and the list no longer show it.

### Upgrading

* **Migration 0077 runs at startup.** It marks the objective nudges already stored as notes, so existing conversations lose them too. A message you wrote while one of those turns was running is left as it was.
* Recreate the gateway and web containers with the 1.0.1 images, or follow the `latest` tags. Nothing to configure.
* **Remote Control:** promote `@jian-ai/remote-control@1.0.1` on npm, or rely on the gateway's `/jian-remote.mjs` auto-update. It has no changes of its own.

## 1.0.0 — 2026-10-29

The panel as its own web server, one installation-wide set of model defaults, MCP servers and SSH keys, conversations that ask before their agent acts, subagents on models sized to their work, file diffs, pull requests and issues in the chat, a phone layout with a tab bar, Grok image and speech generation, and WhatsApp Business through Meta.

### Panel

* **Its own web server:** the panel is no longer a static export inside the gateway. It ships as its own image, `ghcr.io/lucasaarch/jian-web`, which serves the panel at the root of its origin and passes `/v1`, `/health`, `/openapi.json` and `/jian-remote.mjs` to the gateway, so the browser, channel webhooks, OAuth callbacks and remote workers keep one address. Pages render per request under a nonce-based script policy. The gateway answers `/ui` with a page explaining the move. See `docs/deploy.md`.
* **Addresses per agent:** every screen lives under `/agents/:profileId`, and a conversation has its own address, `/agents/:profileId/sessions/:sessionId`. `/` opens the agent this browser had open last. Screens shared by every agent (Providers, Model defaults, Integrations, SSH keys, Remote Control) move to a **Gateway** area under `/settings`, which works before the first agent exists. Old addresses redirect.
* **On a phone:** the header gives way to a tab bar of Overview, Chats, Channels, Schedules and the menu, which steps aside inside a conversation. The layout draws edge to edge and keeps clear of the status bar and the home indicator, and no field is smaller than 16px, so Safari no longer zooms in when one is focused. The composer and the agent toolbar fit a phone's width, and a page iOS leaves shifted after its keyboard closes is put back.
* **Chats:** every conversation is listed, not the first hundred. The channel is chosen with a standard select, the new chat button is primary, the chat list collapses, and the conversation reads in a 52rem column. A minimap beside a long conversation marks each message you sent; pointing at a mark shows it and how the agent began to answer, and a click goes there. It shows only where there is room.
* **Titles:** a new conversation is titled by its own model from its first message, in the background, outside the agent's turn. The request is counted on the run. When the model cannot answer, the opening itself stays the title.
* **Composer:** the repository and the machine sit above the box, which keeps attach, protection, the model, its effort, the microphone and send. The model menu is searchable and as wide as its names, and offers **Fast** where the vendor has it. The microphone opens into a recording capsule that makes room in the row. Attachments preview, share one height, and voice notes count their seconds and rewind when they finish. The composer floats on glass over the end of the conversation.
* **Sign in with ChatGPT** copies the device code, opens OpenAI's page in a new tab and shows the code large until the login connects.

### Approvals

* **Ask first:** each conversation has a protection mode, **Ask first** (the default, existing conversations included) or **Full access**, chosen in the composer and in a channel conversation's toolbar. In Ask first an action parks the run on an approval; approving runs exactly the stored call once, and rejecting runs nothing. Subagents never act under a conversation that asks. Jev no longer gates actions.
* **In the conversation:** an approval is a card with what the action does and its request as highlighted JSON. A question from the agent (`ask_user`) lists its choices, marks the recommended one, and keeps the answer once given. Neither leaves a line in the conversation after it is decided.
* **On WhatsApp and Telegram:** only a contact marked **Can approve** decides, by replying in the chat, in wording each channel can change. The panel shows those cards read-only and refuses to decide them.

### Agents

* **Every agent manages itself, searches the web, learns from its work and talks with the others.** These were switches in Identity; they are now what every agent does. Web search still needs the Tavily key under Providers.
* **Subagents on a model sized to the work:** a subagent runs at a tier (light, standard or deep), named by the principal or read from the brief by Jev. The tier maps to a model the installation offers, ChatGPT and Claude subscriptions first, then Grok, then API keys; without one it uses the parent's model.
* **The Thought Line:** a turn opens with what the agent is doing, a clock and the tools it used folded beneath. The agents a turn handed work to are cards inside it, kept in sight in a dock above the composer while they work, and followed in a drawer beside the conversation. A finished agent shows a check.

### Code

* **File diffs:** `write_file` and `edit_file` record what they changed, line by line, and the conversation shows each change as a diff with both line numbers and syntax colours, in the dark and the light theme. An action approved in Ask first shows as done, with its diff.
* **Code blocks:** fenced code in a message is drawn with its language, line numbers, highlighting and a copy button.

### GitHub

* **A native integration:** a GitHub App connection gives every chat the official GitHub MCP server for each connected account, and a built-in `github` skill teaches its tools. Installation tokens are reused until shortly before they expire.
* **Pull requests and issues in the chat:** a link to one, from the agent or a person, is a card with its state and checks. It opens in the drawer: a pull request shows branches, merge state, checks, reviews and its changed files as diffs, with **Merge** (guarded by the head commit you saw) and **Fix conflicts**, which asks the agent to resolve them; an issue shows labels, assignees, its description and comments. On WhatsApp and Telegram the drawer only reads.
* **Projects are repositories:** the Projects screen is gone. The composer lists every connected account's repositories as `owner/repo` with their visibility; choosing one opens, or reuses, this agent's project for it.

### Images and media

* **Pictures in a frame:** an image the agent is drawing, or one being fetched, is a frame of shifting blocks in the shape it will have, and the picture resolves into that same frame from a mosaic once it is here. One that fails offers to try again.
* **Shapes:** `generate_image` takes an aspect ratio (1:1 by default; 16:9, 9:16, 4:3, 3:4, 3:2 and 2:3). Gemini and Grok draw it as asked; OpenAI gets the nearest size it offers.
* **Grok:** xAI's image models generate images, and **Grok text to speech** speaks in xAI's voices (Eve by default).
* **Gemini** models listed under both their stable and preview ids appear once.

### Models

* **One set of model defaults for the installation,** edited under Gateway → Model defaults. A conversation can still pick its own model.
* **Fast:** Anthropic's fast mode on Claude Opus 5.5, Opus 5 and Opus 4.8, and OpenAI's priority tier on GPT models, chosen beside the model and frozen with the run.

### Channels

* **WhatsApp Business through Meta's Cloud API:** an independent connector for one-to-one customer support, set up in two stages (a callback URL first, credentials after), with images received and follow-ups inside the customer-service window. See `docs/channels.md` for Meta's requirements.
* **AI replies per contact:** a WhatsApp, Telegram or agent-to-agent conversation has an agent toolbar in place of the composer, with the conversation's model and effort and the contact's **AI replies** switch, on every channel.
* **The same controls on every channel:** **Channel enabled**, **Allow all contacts** (Allow all senders on the API server) and a destructive **Disconnect**. Groups still need approval everywhere.

### MCP

* **One set of MCP servers for the installation,** under Gateway → Integrations → MCPs, with their values and sign-ins in the installation's vault. Every run reaches the list as it stands when the run starts.
* **Test connection** in the form tries the server as filled in without storing anything, and saving an OAuth server opens its sign-in in a new tab.
* **Static OAuth clients:** an authorization server without dynamic client registration (GitHub Copilot MCP at `https://api.githubcopilot.com/mcp/`) takes a pre-registered client id, and secret when it has one. The Start from preset picker is gone.

### Workspace and machines

* **One set of SSH keys for the installation,** under Gateway → SSH keys, the private halves in the gateway vault. Each run writes them into the agent's workspace under `~/.ssh/jian/<id>/`, so Git and SSH work as before.
* **Virtual displays:** `jian-display -- COMMAND` runs a GUI application on its own authenticated, software-rendered Xvfb inside the command sandbox, for screenshots and rendering checks. See `docs/security.md`.
* **Remote Control:** every agent uses every connected machine, and the panel shows one install command. A stopping worker reports itself offline at once.
* **Skills:** built-in skills are searchable cards, each with View and a switch for this agent. Importing a skill from a GitHub address stays.

### Removed

* The Claude and Codex skill marketplaces.
* Stickers: the collection, its tools, its skill and its model role. A still sticker someone sends arrives as an ordinary picture labelled `[Sticker]`.
* The GitHub CLI in the image: GitHub's API goes through the integration, and Git through the installation's SSH keys.
* Live voice.
* The per-agent Identity switches `allowSelfManagement`, `allowWebSearch`, `learnFromWork` and `reachableByAgents`, and each machine's list of allowed agents.

### Fixes

* The owner is no longer rate limited: all of the panel's requests arrive through one web server and shared one budget, so a busy chat got 429s. Rate limits now apply as intended to public routes, webhooks and sign-in.
* Opening an agent's drawer keeps your place in the conversation, and a long conversation scrolls inside its pane instead of pushing the page.

### Upgrading

This release changes how Jian is deployed and moves several settings from each agent to the installation. Back up the database first.

* **Run the web image in front of the gateway.** The gateway image no longer serves the panel. Add a `jian-web` service with `JIAN_GATEWAY_URL` pointing at the gateway, publish only the web server, and set `JIAN_TRUSTED_PROXIES` on the gateway so it believes the addresses the web server forwards. The Compose file behind `make up` already does this; other deployments follow `docs/deploy.md`.
* **Migrations 0059 to 0076 run at startup.** They merge each agent's model defaults, MCP servers and SSH keys into one installation-wide set: a shared MCP definition becomes one server, and two servers with one name but different settings both stay, the others as `name_2`, `name_3`. On its first start the gateway re-encrypts the merged MCP secrets into the installation's vault and imports SSH keys found only in workspaces; a second start finds nothing left to do. They also drop stickers and the removed switches, and turn on **Ask first** for every existing conversation. Keep one gateway replica while they run.
* **Review after upgrading:** Gateway → Model defaults, Integrations → MCPs and SSH keys, since each now applies to every agent. Expect agents to ask before acting until you set a conversation to Full access. On WhatsApp and Telegram, mark the contacts who may approve with **Can approve**.
* **GitHub:** a profile that had logged `gh` in for private pull request polling needs the owning account connected under Integrations instead. Integration return paths are now `/settings/integrations`.
* **HTTP clients:** the strict profile schema refuses the removed switches, the projects API takes only the account and the repository, and machine access lists are gone. Regenerate clients from `/openapi.json`.
* **Remote Control:** promote `@jian-ai/remote-control@1.0.0` on npm, or rely on the gateway's `/jian-remote.mjs` auto-update.

Stable installations can use the `latest` tags of both images or pin `1.0.0`.

## 0.8.5 — 2026-10-22

Rust toolchain and Fontconfig in the workspace image, Jian Remote Linux systemd system-unit fallback, MCP legacy fallback for dual-era servers (Atlassian v2), Listening that stays silent while watcher state is unchanged, and a refreshed Codex catalog pin for GPT-6.1 Sol.

### Models

* **GPT-6.1 Sol:** ChatGPT-connected accounts keep selecting `gpt-6.1-sol` (display name GPT-6.1 Sol) when their Codex catalog offers it. The gateway now requests the Codex model catalog with client version `0.163.0` (current Codex CLI) so the account list stays aligned with models whose minimum client version is newer than the previous pin. Reasoning efforts stay `low` / `medium` / `high` / `xhigh` / `max` when the catalog reports them; Jian still does not offer Codex `ultra` (Ultracode / subagent delegation) as a reasoning level. API-key OpenAI accounts continue to learn the same id from `GET /v1/models` plus the public models.dev catalog for limits and list prices. Fast and Ultrafast remain OpenAI `service_tier` modes, not separate model ids, and are not yet selectable in the panel.

### Workspace

* **Rust development toolchain:** the workspace image now includes stable Rust, Cargo, `rustfmt`, and Clippy. Cargo keeps its cache under each user's home directory, so it remains writable and can persist with the workspace volume.
* **Fontconfig development files:** the image includes `libfontconfig1-dev` and `pkg-config`, allowing Rust projects that depend on Fontconfig to compile without asking the workspace user to install system packages. This enables Lemon's Linux checks in the workspace.

### Remote Control

* **Linux headless / root VPS install:** `jian-remote install` still prefers `systemd --user`. When the user bus is unavailable (`Failed to connect to bus: No medium found`, missing `XDG_RUNTIME_DIR` — typical on root SSH to a VPS), it falls back to a **system** unit at `/etc/systemd/system/jian-remote.service` if it can write there, or you can pass `install --system`. Scope is remembered under `~/.config/jian-remote/linux-service-scope` so `stop` / `start` / `restart` / `update` / `configure` keep the same manager. Errors without a usable bus or system write access now print linger / `--system` / foreground `run` instructions. See `docs/remote.md`.

### MCP

* **Legacy fallback after modern refusal:** connecting to an HTTP MCP server still probes with `server/discover` (2026-07-28). When the peer answers that modern serving is disabled — or returns an unsupported-protocol error that lists only pre-2026 revisions — Jian retries with the legacy `initialize` handshake instead of surfacing the refusal in the panel. Modern-only peers and ordinary legacy servers are unchanged. This restores Check / Sign in against `https://mcp.atlassian.com/v2/mcp`.

### Listening

* **Silent while unchanged:** creating an enabled GitHub listener pauses an open session objective so objective auto-continue cannot restate “still pending” every poll interval. Unchanged GitHub snapshots still do not submit a run or deliver to the channel. A real state change (CI conclusion, PR merge/close) reopens the objective and wakes the conversation once. After a subscription wake, auto-continue may run so the agent can act on the event.

### Upgrading

No database migrations. Recreate the gateway container with the 0.8.5 image for the Rust toolchain, Fontconfig headers, MCP legacy fallback, Listening quiet-wait behavior, and the refreshed Codex catalog pin. Model availability still depends on the connected ChatGPT plan or API key; refresh Providers after upgrading if a ChatGPT login was already connected. After upgrading, re-run **Check** on the Atlassian MCP server under Skills → MCP after OAuth sign-in if needed. After releasing, promote `@jian-ai/remote-control@0.8.5` on npm (or rely on gateway `/jian-remote.mjs` auto-update). On a Linux VPS that failed under 0.8.4 with a missing user bus:

```sh
# As root (or with write access to /etc/systemd/system):
npx --yes @jian-ai/remote-control@0.8.5 install --system \
  --gateway 'https://gateway.example' --machine MACHINE_UUID --token WORKER_TOKEN

# Or prefer a normal user:
sudo loginctl enable-linger USERNAME
# as USERNAME:
export XDG_RUNTIME_DIR=/run/user/$(id -u)
npx --yes @jian-ai/remote-control@0.8.5 install \
  --gateway 'https://gateway.example' --machine MACHINE_UUID --token WORKER_TOKEN
```

Stable installations can use the `latest` image tag or pin `0.8.5`.

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
