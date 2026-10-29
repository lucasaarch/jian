# Gateway panel

`apps/gateway-ui` is a Next.js app, React and TypeScript, built with `output: 'standalone'` and run as its own container, `ghcr.io/lucasaarch/jian-web`, in front of the gateway. The panel uses the SDK generated from the OpenAPI document; validation, authorization and domain rules stay in the gateway.

## Build and hosting

`pnpm build` compiles the contracts, the SDK, the gateway and the panel; `pnpm --filter @jian/gateway-ui build` writes `.next/standalone` with the static assets and `public/` placed inside, and `pnpm --filter @jian/gateway-ui start` runs it. `apps/gateway-ui/Dockerfile` ships that tree on `node:24-bookworm-slim`; like the gateway's `apps/gateway/Dockerfile`, it is built from the repository root (`make image`).

The panel lives at the root of its own origin. Every screen belongs to an agent and carries it in the address — `/agents/:profileId/channels`, `/agents/:profileId/sessions/:sessionId` — so a link, a reload or the back button lands on the same agent and conversation; `/` opens the agent this browser had open last. The web server is also the installation's only public door: `app/v1/[...path]`, `app/health`, `app/openapi.json` and `app/jian-remote.mjs` pass those requests to `JIAN_GATEWAY_URL` through `lib/server/gateway.ts`, so the browser, channel webhooks, OAuth callbacks and remote workers keep one origin, and the panel cookie stays same-origin. The pass-through streams both ways, keeps redirects for the browser, drops per-hop headers, closes the gateway's side when the client leaves, and answers 502 when the gateway is down. It is a route handler rather than a Next rewrite: a rewrite to another server cuts responses at 30 seconds, which would end the event stream. `/web/health` is the web server's own liveness; `/health` is the gateway's.

The gateway keeps `/ui/` for installations updated without the web server: it answers there with a page that explains the move ([deploy](deploy.md#moving-the-panel-out-of-the-gateway)). The web server does not carry the old addresses over.

Every page is rendered per request, so the script policy can carry a fresh nonce (`proxy.ts`). Pages are client components; the server makes server components and server-side data loading available without another change to hosting. Fonts, icons and the QR code are local, with no external rendering service.

`make dev` runs `next dev` on `:3000`, with the same pass-through to the gateway on `:4310`.

## Data

The panel holds no workspace in React context. The open agent is the URL's `[profileId]`; what the panel shows comes from [TanStack Query](https://tanstack.com/query), one query per slice (`lib/query`). A section reads the slices it shows with the hooks in `lib/query/agent.ts`, which suspend until they arrive, and is handed only its actions — the client, `mutate` and `busy` — by its page. `mutate` runs an action, reports it and invalidates the agent's queries. The agent's event stream (`lib/query/stream.ts`) invalidates exactly what an event changed, so the panel follows the agent without polling and never asks the providers for their models again on its own. Screens that poll — a machine coming online, a WhatsApp pairing, a ChatGPT login — do it with the query's own interval. The state that is the browser's alone — the agent opened last, the theme, whether the new agent dialog or the release notes are open — lives in [Zustand](https://zustand.docs.pmnd.rs) stores. The panel uses no React context of its own.

## Styles

Each shared component in `components/ui` has one semantic class, written with Tailwind's `@apply` in `app/styles`. When a component looks different somewhere, that look is a variant the component takes — `<Button variant="quiet">`, `<Select variant="ghost" popup="content">`, `<IconButton size="control">` — and becomes a modifier class beside its own (`.select-trigger.ghost`). A screen never restyles a component by nesting a selector under its own class: the next screen that needs the same look would not find it. Where a component sits — margin, width, flex — is the container's, so a wrapper or the container's own rule carries it.

Controls that stand side by side share one height, `control` (46px, what an input measures with its padding, line and border), declared in `app/styles/themes.css`. Buttons and selects take it; an icon button takes it with `size="control"`. Repeated markup becomes a component in `components/ui` (`SearchField`, `IconButton`); a link that looks like a button takes `buttonClass(variant)`.

`pnpm --filter @jian/gateway-ui knip` runs in `pnpm check` and fails on an unused file, export or dependency.

## Tests

`pnpm --filter @jian/gateway-ui test` runs the panel's unit tests in happy-dom, with no gateway and no network. A section is rendered inside `<AgentCache profile={...} slices={...}>` from `test/agent.tsx`, which puts the agent's slices in a cache of its own and the agent in the URL; its actions are handed in as props, so a test injects the client calls it checks. `test/setup.ts` stands in for Next's router, and `test/fixtures.ts` holds the synthetic agent and usage the tests share.

## Setting up a profile

1. Sign in with the host token, `JIAN_API_TOKEN`.
2. Create a profile with a name and instructions. Role, tone and goals belong in the instructions.
3. Under **Providers**, one row per vendor, configure a credential for Anthropic, Gemini, OpenAI or xAI. `ANTHROPIC_API_KEY`, `ANTHROPIC_API_TOKEN`, `GEMINI_API_TOKEN`, `OPENAI_API_KEY` and `XAI_API_KEY` in the environment are detected on their own. OpenAI also accepts a ChatGPT login by device code. The API key and ChatGPT login coexist; image generation and speech synthesis use the API key. A credential belongs to the installation: configure it once and every profile can use it.

   Anthropic issues two credentials that are not interchangeable, so its row asks which one you are pasting: an API key, sent as a key, or a subscription token from `claude setup-token`, sent as a bearer from a caller presenting itself as Claude Code. Either one sent as the other answers 401 on every run and on the model listing. Unstated, the choice is read from the credential's own prefix, and failing that from the variable it came in — `ANTHROPIC_API_TOKEN` holds the bearer one.
4. Under **Model defaults**, choose the model for each activity. One menu lists the models of every connected provider, each with its provider's name under it; picking a model picks its provider. The list comes from the provider account, never from a list written in this repository, and the panel marks the models whose capabilities the gateway cannot catalog. Reasoning effort appears where the model accepts one. With nothing chosen — or with a chosen model whose provider was removed — the first run picks a model and saves it as the default. When there is no model to pick at all, a message arriving on WhatsApp or Telegram is kept in its conversation and the chat is told, once every ten minutes, that no model is set up; it no longer waits in silence.

   Model defaults execute conversations, channels, context compaction, image analysis, image generation, incoming audio and text to speech. Each picker filters incompatible models. Compaction uses its selected model, falling back to the conversation model, and can run automatically or through `compact_context`. Empty media selections use Gemini (`gemini-flash-latest`, `gemini-2.5-flash-image`, `gemini-2.5-flash-preview-tts`). Image generation also supports OpenAI GPT Image and DALL-E with an API key. When a provider does not answer, its last model list stays visible with a warning.

5. Add skills, written on the screen or imported from a GitHub repository in the open `SKILL.md` format — the same one Claude Code, Codex and Copilot read. An import copies the instructions once and records where they came from; the repository changing later never rewrites what the agent already follows, and only the owner imports. Under **Gateway → Integrations → MCPs**, connect MCP servers, which every agent reaches: the tools come from the server, and the agent loads one before it can call it. A server is reached over HTTP or by running a command on this machine, and an HTTP one authenticates with headers you write — `Bearer`, `Basic`, anything it asks for — or by signing in to the server itself, which needs `JIAN_PUBLIC_URL` so the redirect can come back. The built-in skills are cards on the same screen, searchable by name or description, each with a switch that turns it off for this agent. An import copies the instructions only: scripts and supporting files are not installed.
6. Under **Channels**, connect WhatsApp, Telegram or the API server. Each type exists once and reads as connected or not, as under Providers. For a room with several agents, connect one channel per profile — a number or a bot for each — and approve the room in every profile that should speak in it.
7. Under **Sessions**, read the history by channel and search by title or identifier. At the top of a conversation, **Model** and **Effort** choose the model for that conversation alone, from its next turn; **Default** returns it to Model defaults, which every agent shares. Only the gateway conversation is written to from the panel; the others are written to through their channels. The worker must be running for incoming messages to be processed.

The ChatGPT login talks to the Codex backend with the same context cycle, tools and usage recording as the rest of Jian, and its own model catalog is read from that account. OAuth tokens are encrypted in the vault and refreshed by the gateway. Do not paste a login token into the API key field. Older profiles carrying `model` and `contextPolicy` stay readable and usable.

Connecting WhatsApp means scanning the QR code: the panel opens the pairing immediately and follows the connection and the first encrypted copy of the session. The QR expires and is never written to the browser. Connecting Telegram means giving the BotFather token, which the gateway keeps encrypted; the panel shows the webhook URL and secret once, and `setWebhook` remains a step you take outside. Connecting the API server produces the same URL and token. Nothing else is asked — no name, no session, no list of senders.

Whoever writes for the first time appears under **Contact requests**, with their name, their identifier and the message that was held. Approving opens the conversation and releases that message; refusing blocks the sender silently. The request arrives on its own: the panel follows the profile's event stream and refreshes when a contact or a channel changes, with no page reload. See [channels](channels.md) for the guarantees on the gateway side.

A room appears in the same list, marked as one, and approval covers the whole room: there is no request per participant, and nothing is held waiting for a decision. Once approved it appears under **Rooms**, with its name, its channel and which of your profiles are in it — each profile joins through its own connection, so each is approved separately, and the panel shows the ones still pending as not participating. Inside a room with more than one agent, each answers only when a message carries its name, and the conversation between agents stops at the turn limit until a person writes again.

Secrets have no screen of their own: a provider key is typed under **Providers**, an MCP server token next to its server, and a bot token next to its channel. The vault keeps encrypting them without showing anything in the panel, and no value is ever displayed again — to change one, send another; to remove one, remove the thing that uses it.

**Memories** is read-only: the screen lists what the agent kept, searches by key and by content, and deletes an entry. The agent is the one who writes, through its own tools.

The activity calendar counts a day as it ends where the reader is: the browser's own zone travels with the request, because a calendar drawn in UTC puts an evening in Brazil on tomorrow's square.

## Integrations and projects

**Integrations**, under **Gateway** at `/settings/integrations`, are installation-wide and shared
by all profiles: the GitHub App and the MCP servers. A server's typed values and its sign-in live
in the installation's vault, so every agent reaches it with the same credentials. The GitHub integration creates
its GitHub App through GitHub's manifest flow and stores its generated credentials in the encrypted
gateway vault. Configure the gateway's `JIAN_PUBLIC_URL` before registering the App. Users may connect multiple GitHub accounts and choose
which repositories the App can access. Every chat then has GitHub's MCP tools and the `github`
skill: a chat in a GitHub-backed Project reaches only that repository, and any other chat reaches
each connected account (`github`, or `github_<login>` with several).
**Projects** remain profile-specific and live in the composer: its project list starts with
**New Project**, a dialog that takes a name and one repository from a single list of every
connected account's repositories, named `owner/repo`; the gateway verifies that choice. Each
project in the list shows its repository as `owner/repo`. See
[`docs/deploy.md`](deploy.md#github-app) for App permissions and callback setup.

## Security and limits

- The sign-in page and the assets are public. Every API route needs the host token, or the panel cookie signed with it; there is no reduced-permission client key.
- The sign-in form only enables submission after hydration and falls back to POST, so the token never travels in a URL. The host token is exchanged once for a session cookie and is kept in neither localStorage nor sessionStorage. Visual preferences — accent colour, light or dark mode, motion and text size — live in localStorage. The mode defaults to the device's own setting. Every colour is declared once with `light-dark()` in `app/styles/themes.css`, so an accent is one entry with a light and a dark value, not a second theme.
- The panel cookie is `HttpOnly`, `SameSite=Strict`, valid for 30 days, and `Secure` when the request arrives over HTTPS. It carries only its own expiry and an HMAC signature derived from `JIAN_API_TOKEN`: nothing is stored in the database, and changing the host token ends every open session. Reloading keeps the session; signing out deletes the cookie.
- The gateway accepts the cookie only on requests that also send `x-jian-panel: 1`. A custom header needs a CORS preflight, which neither the web server nor the gateway grants, so another site cannot use the cookie. Sign-in has its own limit of 10 attempts a minute.
- Requests go to the same origin, with no cache and with a timeout. The panel carries no credentials in its build.
- The content security policy allows scripts from the panel's own origin and the nonce minted for that request; Next stamps it on every script it renders. Framing, plugins and changing the base URL are blocked. Pages are never cached, since each carries its own nonce.
- The web server holds no secret. The gateway believes the client address, scheme and host it forwards only from `JIAN_TRUSTED_PROXIES`. The address is the one the client or the platform in front stated, so the rate limits keyed on it are a fairness measure; the host token's length is what resists guessing.
- Input is rendered as text; history and instructions never execute HTML.
- A profile change carries `expectedVersion`. The panel does not create sessions and does not send messages.
- Listings follow the API's current limits: up to 100 sessions, recent messages, memories and deliveries, up to 200 contacts, and up to 500 room contacts across the whole installation. The panel does not replace the paginated history API.
- The event stream uses the same session cookie and the same header as every other call, read through `fetch` because `EventSource` cannot send headers. The gateway rechecks the session on every cycle and ends the stream when it expires; the panel reopens from the last event it saw.

Infrastructure stays in the server configuration: PostgreSQL, the encryption keyring, the host token, the API/worker role, HTTPS and the network rules. The panel does not turn this single-owner installation into a multi-tenant SaaS.

Looking at the screen, and local HTTP tests, prove neither PostgreSQL persistence nor delivery through an external service nor a real WhatsApp pairing.

Incoming audio uses one selection for WhatsApp voice notes and attached audio files. It preserves speech verbatim and adds relevant sound context when the model supports it. The deprecated API `transcription` field is a compatibility alias for `audio`; existing selections are preserved, with `audio` taking precedence.

The composer microphone control records a voice note attachment. Audio calls are not part of the panel.
