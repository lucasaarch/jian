# Channels

A profile has four possible channels — WhatsApp (Baileys), WhatsApp Business (Meta), Telegram and the API server — and at most one of each. Connecting is the whole configuration: there is no name, no chosen session and no list of senders. Who may talk to the agent is decided afterwards: contact by contact in private conversations, and once per room in groups.

`POST /v1/profiles/{profileId}/channels` configures a type. The API server uses the one-time `webhookToken` (only its hash is kept); Telegram uses it for webhook authentication. Meta uses its own signed webhook and verify token instead, and Baileys has no HTTP intake. A second channel of the same type answers `409`. `DELETE /v1/profiles/{profileId}/channels/{channelId}` disconnects, deletes the channel's secret from the vault and frees the type for a new connection. Approved contacts and their conversations are kept.

## Pause automation without disconnecting

In **Channels → Manage**, **Channel automation** pauses/resumes a channel without revoking it, relinking it, or clearing credentials, configuration, contacts or history. The host-only `PATCH /v1/profiles/{profileId}/channels/{channelId}` accepts `{ "enabled": false }` to pause and `{ "enabled": true }` to resume. `channel.enabled` defaults to `true`, including existing channels where the field was absent.

A disabled channel starts no automated ingress/runs and sends no outbound deliveries, including queued replies. Queued, running and waiting runs in its contact sessions are cancelled; requests already in flight may still finish at their provider. Incoming messages are ignored while paused; resuming never replays a backlog. A network request already in flight may finish. **Disconnect** remains a separate destructive credential-removal action, not a pause control.

For WhatsApp Business, manual service in the Business app is untouched **if the account already supports it**. Jian does not provision, enable or guarantee app/API coexistence; eligibility and setup remain with Meta.

### Pause AI in one Business chat

Open the contact's chat in **Conversations**. Its header contains the **AI replies** switch for WhatsApp Business, separate from Approve/Revoke in Channels. `contact.aiEnabled` defaults to `true`. The host-only `PATCH /v1/profiles/{profileId}/contacts/{id}` accepts `{ "aiEnabled": false }` to pause and `{ "aiEnabled": true }` to resume; clients use `api.updateContact(profileId, id, { aiEnabled })`.

A chat pause prevents AI runs and AI output, including queued replies. Incoming messages are acknowledged and ignored while paused, never automatically replayed on resume. Already in-flight network requests may finish. Toggling AI does not approve a pending/blocked contact; approval does not override a pause. Both the channel and chat must be enabled, and normal approval and Meta customer-service-window restrictions still apply.

## Contacts and approval

By default, the first message from an unknown sender does not enter the profile. The gateway records a contact request with who wrote and what they said, tells the person once that the owner has to approve, and holds the message.

| Method and path | Behaviour |
| --- | --- |
| `GET /v1/profiles/{profileId}/contacts` | Pending requests first, then approved and blocked |
| `POST /v1/profiles/{profileId}/contacts/{contactId}/approve` | Opens the conversation's session and releases the held message |
| `POST /v1/profiles/{profileId}/contacts/{contactId}/block` | Discards the message and ignores the sender silently |

All of them need the host token: approving is granting access to the agent.

**Allow all contacts**, available for both WhatsApp (Baileys) and WhatsApp Business (Meta), is an opt-in channel setting (`PATCH` with `{ "allowAllContacts": true }`, default `false`). It allows new private contacts without manual approval; blocked contacts remain blocked, groups still require approval, and no contact gains owner access. This permission does not override channel/chat pauses or Meta reply-window rules.

Rules the implementation guarantees:

- One request per sender, not per message. If the stranger insists, the new text is appended to the same request, up to 8,000 characters.
- One automatic notice per request. Later messages from someone who is waiting produce no answer, which is what keeps two automated systems from looping.
- A blocked sender receives nothing and starts no run.
- While pending, a sender has no session, no run and no history in the profile.
- Approving opens that conversation's session and sends the held message. Its idempotency key comes from the channel, the chat and the original message id, so a protocol redelivery and a second approval recover the same run instead of creating another.

The automatic notice only exists on channels that can answer. The API server only receives: the HTTP response carries `contact: "pending"`, and it is up to the caller to tell their user.

## A session per conversation

Each conversation is a session of the profile, created on approval and titled with the channel and the sender — `WhatsApp · 5511999999999@c.us`, `WhatsApp · Team room`. Nothing is configured for that. The sessions appear under **Sessions** in the panel, share the profile's identity, tools and memories, and keep their history apart. A room's session is separate from the private conversations of the same people.

## Rooms

This section describes Baileys, Telegram and custom API rooms. WhatsApp Business (Meta) groups are unavailable in this prototype; its separate restrictions are documented below.

A room is a conversation where several people and several agents write. Each agent joins through its own connection — its own number on WhatsApp, its own bot on Telegram — so the isolation between profiles stays whole: each profile sees the room through its connection, and what the other agents write reaches it as a message from another participant, over the protocol itself. Telegram is the exception: it never delivers a bot's messages to other bots, so once an agent's message is sent to a room the gateway hands it to the installation's other agents approved there, as if the room had delivered it — heard, answered only when it calls them, and counted in the room's budget. There is no shared room and no common transcript inside the gateway.

The channel marks the conversation: `scope: "group"`. On WhatsApp that is a `@g.us` JID, with the participant as the sender and the room as the conversation; on Telegram it is the `group` and `supergroup` chats. A room message becomes a session of the profile identified by the room, and the run receives the author along with the text — `Lucas: Ada, can you look at the report?` — because in a room the agent has to know who spoke to answer them.

### Approval is per room

The owner approves the room once, not each participant. The request records the conversation, and whoever writes there later comes in under the same decision.

- A pending room starts no run, produces no delivery and receives no automatic notice: the gateway does not write inside a room the owner has not approved, not even to explain that it is waiting.
- Nothing is held. In a private conversation the first message waits for approval and is released afterwards; in a room it is not kept, because releasing it would make the agent answer a message that called nobody.
- Each profile sees the room through its own connection, so each has its own request and its own session. Approving for one profile approves for none of the others.
- Renaming the room does not reopen the request; the new name updates the title.

### The agent reads everything and answers when called

An approved room behaves like a person who follows the conversation without taking part: the agent reads every message, and answers only the ones that call it — even when it is the only agent there. A message that does not call it is written to the room's session as `Author: text`, with no run and no delivery, so when it is called it answers with what the room already said. A redelivered message is written once. An attachment in a message that did not call the agent is noted but not opened: opening it costs a provider call.

A person calls the agent the way the protocol offers:

- A mention of its connection — `mentionedJid` on WhatsApp, resolved from LID to phone; on Telegram a `text_mention`, or the bot's `@username`, which the channel reads with `getMe` when it connects. A Telegram channel connected before this learned no username, and has to be connected again for `@username` to call it.
- A reply to one of its messages.

Writing the agent's name is not a call: people also talk *about* the agent. Agents of the installation cannot mention or quote, so a message from another agent calls by name instead — compared without case or accents, at word boundaries, a compound name also answering to its first word at three letters or more.

On Telegram a bot in privacy mode receives only the messages that call it, and then reads nothing else. Turn privacy off in BotFather (`/setprivacy` → Disable) and add the bot to the group again for the change to reach that group.

### The loop between agents ends

An agent can call another inside a room, and that has to stop: every agent spends real money on every turn. The limit is `GROUP_AGENT_TURN_LIMIT`, today 3, and it belongs to the room rather than to each agent — the same budget idea as the conversation between profiles, counted across what everyone wrote instead of restarting at each one.

Each profile counts, on the room's contact, the agent turns since the last message from a person: the messages it sees from the other agents plus the replies it sends itself. Past the limit the agent goes quiet; since everyone counts the same traffic, everyone goes quiet. A message from a person resets the count and gives the budget back to the room. A turn is never charged twice: the contact keeps the identifiers of the messages it has seen, so a protocol redelivery is the same turn, recovers the same run and produces no second answer.

### Who counts as an agent

The gateway recognises a participant as another profile of the installation by the address of its connection: the channel keeps in `address` what that connection speaks as — the paired account on WhatsApp, recorded when the device connects, and the bot id on Telegram, asked once through `getMe` when the channel connects. The address appears in no API response.

A connection the protocol cannot identify has no address, and its messages count like anyone's: the agent still answers only when called, but that traffic does not spend the room's budget. A message from the connection's own address is an echo and is discarded before it becomes a run.

### What the owner sees

`GET /v1/groups` lists the rooms the installation knows, each with the profiles in it, the state of each request and the room's name. It is the one route that crosses profiles, because the room belongs to all of them; it needs the host token, like the rest of the panel.

### Limits

- On Telegram a bot does not receive messages from another bot, and the default privacy mode hides from it the messages that do not mention it. So: people talk to agents in a Telegram room, but a conversation between agents only really happens on WhatsApp. The gateway's rule is the same on both.
- A WhatsApp room's subject is read once per room and kept in the worker's memory; a renamed room only changes name in the panel after the worker restarts.
- The answer goes to the whole room: there is no private reply to one participant inside it.

## API server

Send `actorId`, `chatId`, `text`, `requestKey` and, if you have it, `displayName` to `POST /v1/ingress/{channelId}`, using `X-Jian-Channel-Token`. For a room, send `scope: "group"` with the room's `chatId`, the `actorId` of whoever wrote and, if you have them, `groupName`, `mentions` and `replyTo` — the address of whoever wrote the message being answered. This channel has no identity of its own on a protocol, so the agent is called by its channel id, in `mentions` or `replyTo`. The adapter that calls this route must authenticate the external identity before filling the ids in; whoever holds the token can represent any sender, and each new sender becomes a contact request. The answer carries `accepted`, the run id when there is one, and the contact's state. Read results through the admin API.

This channel sends no answer back to an external service. Turning it into an OpenAI-compatible endpoint is a task of its own; what is described here is the intake as it stands.

## Telegram

1. Connect the channel with `type: "telegram"` and the BotFather token in `botToken`. The gateway encrypts the token in the vault under `channel:<id>`; it comes back in no response. To change it, disconnect and connect again.
2. The gateway calls `setWebhook` immediately with `https://<host of the request>/v1/telegram/{channelId}`, the `webhookToken` as `secret_token`, and `allowed_updates` limited to `message`. The response carries `webhookRegistered`. If it comes back `false` — a gateway on `localhost`, a port Telegram refuses, or Telegram being down — the channel stays connected and the registration can be done by hand with the same values.

The gateway validates `X-Telegram-Bot-Api-Secret-Token` and the contact before accepting a message. A redelivery of the same update recovers the same run. The finished answer is sent as separate messages, split where the agent left a blank line, in plain text with no parse mode. The settings follow the [official Telegram API](https://core.telegram.org/bots/api#setwebhook).

This implementation handles text messages from users with `from`, `chat` and `text`, in private conversations and in rooms; media, edits, callbacks and forum topics are not implemented. `first_name` or `username` becomes the display name on the contact request. In a room, `chat.title` becomes the room name and `text_mention` entities become mentions. For a bot to see the room messages that do not mention it, turn privacy mode off in BotFather.

Under flood control Telegram answers 429 with a wait; the gateway honours it, keeps the delivery queued and stops trying until that moment passes. A delivery that confirmed nothing is repeated; one that partly landed never is.

The worker processes deliveries once the run has finished. `GET /v1/profiles/{profileId}/deliveries` shows `pending`, `sending`, `sent`, `failed` or `unknown`. An uncertain failure is not repeated on its own; read the confirmed message ids before acting by hand.

The host comes from the `Host` header of the connect request, so connect through the public domain, not an internal address. The local tests simulate Telegram and configure no real bot.

## WhatsApp Business through Meta Cloud API

**WhatsApp Business (Meta)** is the independent `whatsapp-business` connector, not a QR-linked Baileys device. The connector supports one-to-one customer support and agent-initiated follow-ups inside an open customer-service window. It does not activate a Meta account, register a production number, complete Embedded Signup, or automatically subscribe a webhook. Setup has two stages: **Setup pending** reserves the callback URL using only a verify token; **Configured** means the remaining credentials were saved and validated, not proof of webhook subscription, a working connection or delivery.

### Prepare a test account

1. Check the current [Meta AI-provider policy](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers), [business terms](https://www.whatsapp.com/legal/business-solution-terms), account eligibility, recipient markets and pricing **before real deployment**. Jian is an agent platform: describing an installation as customer support does not automatically exempt it from AI-provider requirements. Official API access guarantees neither approval nor immunity from account restrictions. Do not assume free usage; test allowances and production charges depend on Meta's current terms.
2. Follow Meta's [Cloud API getting-started guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started). Create a developer app with WhatsApp enabled and use the supplied test number and explicitly allowed test recipients first. Do not migrate the existing Baileys number as part of this setup.
3. For the second stage, obtain an access token for the correct business and number; it is **not required to create the callback first**. A temporary developer token may be useful for initial testing but expires. For an enduring setup, create a system user, assign the app and WhatsApp assets, and issue a system-user token with the required WhatsApp permissions (including `whatsapp_business_messaging` for messaging and `whatsapp_business_management` for account/subscription management). Confirm permissions, asset access and expiry in Meta; a token alone does not grant access to every number.
4. When available, copy the app's **App secret**, the **Phone number ID**, and the **WhatsApp Business account ID (WABA ID)** for completion later. The phone number ID is not a telephone number, and the WABA ID is not a business portfolio ID. Choose a separate, unpredictable **verify token** for the webhook challenge. Keep all three secrets out of logs, screenshots and source control; never put the access token or app secret in a URL.
5. In **Channels → WhatsApp Business (Meta) → Set up**, enter **only the verify token** and choose **Create callback URL**. Keep your chosen value for Meta: it cannot be read back here. Jian creates a channel marked **Setup pending** and shows its actual callback URL with a copy button. No access token or app secret is needed yet, and messaging is unavailable while pending.
6. Use that callback URL and the same verify token in Meta's manual webhook setup (see below). A successful GET challenge does not change Jian's setup status or prove subscription/delivery. Return to the same channel's **Manage → Complete Meta setup** form and enter the access token, app secret, phone number ID and WABA ID. Choose **Complete setup**. The original verify token, channel ID and callback URL are preserved. If validation fails, the channel stays pending and the callback remains the same; re-enter the cleared credentials to retry.
7. Completing setup verifies Graph API v25.0 access and account membership; the configured number must appear in the first 100 entries of the WABA's phone-number list. Otherwise this prototype fails safely rather than assuming membership. Finish the manual subscriptions and test only after completion. **Configured** does not mean Meta's webhook was automatically verified or that messaging is live.

The password fields are uncontrolled, are not saved to browser storage or read back, and are cleared on submission (success or failure) and unmounted on closing the form. The gateway stores credentials in its encrypted vault. Completion is not token rotation: to replace configured credentials or a lost verify token, disconnect and configure again, which generates a new channel ID and callback URL. Existing fully configured channels remain configured.

### Two-stage API setup

All channel-management calls require host authentication (or the authenticated panel cookie). The examples contain placeholders only; never publish real credentials. First, `POST /v1/profiles/{profileId}/channels` with:

```json
{
  "type": "whatsapp-business",
  "whatsappBusiness": {
    "verifyToken": "<chosen-webhook-verify-secret>"
  }
}
```

The response includes a generated `id` and safe `whatsappBusinessStatus: "pending"`, not the verify token. Use that real ID in the callback path. Later, `PATCH /v1/profiles/{profileId}/channels/{channelId}` with:

```json
{
  "whatsappBusiness": {
    "accessToken": "<system-user-access-token>",
    "appSecret": "<meta-app-secret>",
    "phoneNumberId": "<meta-phone-number-id>",
    "businessAccountId": "<whatsapp-business-account-id>"
  }
}
```

Do not send a new verify token in the completion request. Successful completion returns `whatsappBusinessStatus: "configured"`; it uses the stored verify token and keeps the same ID and URL. A validation error does not complete or replace the pending configuration. This credentials-completion payload is for pending setup only, not rotation of configured credentials. Independent `enabled` and `allowAllContacts` PATCH payloads remain available for channel controls.

For clients that already have all five values, full creation in a single POST remains supported:

```json
{
  "type": "whatsapp-business",
  "whatsappBusiness": {
    "accessToken": "<system-user-access-token>",
    "appSecret": "<meta-app-secret>",
    "verifyToken": "<chosen-webhook-verify-secret>",
    "phoneNumberId": "<meta-phone-number-id>",
    "businessAccountId": "<whatsapp-business-account-id>"
  }
}
```

### Subscribe the signed webhook manually

1. Expose the installation through a public **HTTPS/TLS** endpoint reachable by Meta: the web server's origin, which passes `/v1` on to the gateway. Not a development panel origin or an internal address. Configure the callback in Meta as `https://<public-gateway>/v1/whatsapp-business/<channelId>` (route pattern: `/v1/whatsapp-business/:channelId`). `<channelId>` is a placeholder, not literal text to paste: replace it with the generated channel ID from the create response. The panel's copyable URL already contains the real ID automatically. It uses the panel's origin, which is the installation's public origin: the web server passes `/v1` on to the gateway. Do not append `/ui` or use the development panel port.
2. Enter the same verify token in Meta's webhook configuration. Meta calls GET with `hub.mode`, `hub.verify_token` and `hub.challenge`; the gateway verifies the token before answering the challenge, including while setup is pending. Pending channels cannot accept message POSTs or send replies until completion. The panel does not track whether Meta performed or accepted this challenge. This challenge does not authenticate later POSTs. Meta sends the verify token in that GET query: disable query-string access logging for this endpoint at the reverse proxy or redact `hub.verify_token`.
3. Subscribe to the WhatsApp `messages` webhook field and subscribe the app to the intended WABA (through Meta's tooling or its `/{WABA-ID}/subscribed_apps` Graph API operation). Saving credentials in Jian does neither of these subscriptions for you.
4. POST payloads must carry a valid `X-Hub-Signature-256`: HMAC-SHA256 over the original request body with the app secret. A reverse proxy must preserve the signed body and header. The channel also checks the configured account and phone number IDs; a valid app signature is not permission to route another number's messages to this profile. Do not use the API server's `X-Jian-Channel-Token` or `/v1/ingress` endpoint for Meta.
5. Send a message **from an allowed test customer's phone to the test business number**, approve that contact in Jian, and observe both the conversation and delivery results. A successful save, challenge, Graph API acceptance or local `sent` record is not proof that a customer's phone received a message. Check actual status events and the recipient device. These instructions do not claim any real account activation or live integration verification.

Start with a dedicated Meta app and a single-number test account for each channel in this prototype. An app-level callback is not a per-profile routing table: replacing it with another channel's URL can stop the first channel receiving events. Batches containing a different account or number are rejected rather than routed across profiles. Sharing one app across channels would require explicitly configured per-number webhook overrides or a separately designed app-level router; this prototype does not configure either.

See Meta's [webhook setup](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint) for the current dashboard and subscription requirements.

### Reply window and prototype limits

- Only a valid **customer inbound message** opens or renews that customer's **24-hour customer-service window**. Agent replies, delivery receipts, contact approval and background work do not renew it.
- Free-form replies are checked at send time, not just when a run begins. If the window expires while an answer, progress update, audio reply or delayed result is being prepared, that reply is blocked. The customer must write again to reopen the window. Local contact approval is not Meta opt-in and cannot bypass this restriction.
- **Agent-initiated messages are allowed to approved contacts inside their open 24-hour window**, including scheduled follow-ups, conversation writes and contact-message tools. They do not need to be a direct reply to the latest inbound turn. Channel/chat pauses, cancellation and stale-work cutoffs still apply to every send, including delayed output and media. Pending contacts may only receive the gateway's approval notice tied to their own signed inbound message. **Templates and sends outside the window are not implemented**; there is no silent fallback to Baileys or another connector. Contact approval is not consent for unsolicited marketing; applicable consent rules still apply.
- **Audio is limited to Ogg/Opus mono voice messages, up to 16 MB, in both directions.** Other audio formats, outgoing images, documents and stickers are not supported by this connector. An unsupported or failed incoming audio download becomes an explicit unreadable-audio note, not an invented transcript. Incoming audio uses the profile's existing media/transcription settings after contact approval; outgoing voice uses the existing speech tools. Plain-text replies are limited to 4,096 characters per message.
- **Incoming images are supported**, with or without captions: JPEG, PNG, WebP and GIF, up to 16 MB and 40 million pixels. The connector validates downloaded bytes, MIME, size and available hashes before attaching the image to the conversation. A failed download or invalid image becomes an explicit unreadable-image note, preserving the caption; it is not silently dropped or described as if seen. Vision still depends on the profile's model/media settings. Images from pending contacts remain staged until approval; paused chats/channels ignore them without downloading.
- **Groups are unavailable.** A future Groups API integration would need separate eligibility and payload validation. Meta currently documents an **Official Business Account (OBA)** requirement, a maximum of **8 participants**, only **one Cloud API business per group**, and invitation-based participation. A normal Cloud API account is not automatically an OBA; ordinary Baileys groups cannot simply be joined or imported. Check the current [Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups) and [OBA requirements](https://developers.facebook.com/documentation/business-messaging/whatsapp/official-business-accounts) before planning this work.
- **No contact, approval, session-history or group migration between connectors.** Baileys and Meta retain separate channel identities and permissions even when the same person writes on both. Disconnecting retains that connector's local history; it does not transfer it to another connector.

### Durability and validation limits

Signed webhook batches are persisted transactionally before HTTP 200, with a 3 MB limit specific to this route. The durable inbox retains completed event keys and payloads for the channel's lifetime; there is no automatic retention or compaction policy yet. Profile/channel deletion cascades inbox data. A processing attempt has a ten-minute crash-recovery lease; message keys make contact intake, media storage and run submission replay-safe. This does not promise exactly-once execution of arbitrary external model tools.

Media downloads use fixed Graph/CDN HTTPS hosts, no redirects, a 20-second request deadline and a streaming 16 MB ceiling. Ogg/Opus identification checks are not a full decoder. An uncertain message write (timeout, ambiguous acceptance, or Graph 5xx) becomes terminal `unknown`, with no automatic resend. Graph 4xx refusals become terminal failures. Delivery status events are kept separately and never start model runs; the deliveries API exposes remote receipts and safe local failure explanations.

Automated coverage uses shipped migrations, disposable databases and mocked Graph responses. No real account activation, webhook subscription, phone delivery, audio decoding/transcription, token rotation or eligibility verification is implied. Those checks require an explicitly authorized test-number exercise before production activation.

## Adapters

Each protocol implements `Channel`, in `apps/gateway/src/channels/channel.ts`. `ApiChannel` normalises HTTP intake; `TelegramChannel` reads updates and sends answers. `WhatsAppChannel` uses the linked-device connection the worker keeps; the separate Meta adapter uses Cloud API credentials and signed HTTP intake. `ChannelRegistry` picks the adapter by type. The shared `Channels` service owns authorization and delivery, with protocol-specific setup and authenticated ingress where required.

The interface defines the optional webhook authentication header, the intake normalisation, the optional send and the optional typing indicator. The absence of `send` means the channel only receives: the API server produces no fictitious delivery and no approval notice. Credentials and the guarded HTTP client are handed to an adapter only while it sends.

The shared service keeps the shared guarantees: token authentication, the contact decision, binding to a profile and a session, deduplication, recording the delivery and recovering uncertain states. Adapters choose no permissions and touch no database. Before sending, the service writes `sending` in a transaction; if it loses the confirmation it records `unknown` rather than repeating a possible outside effect.

An answer reaches a chat as the messages it was written in, split where the agent left a blank line, with the composing bubble and a short pause between them. Markdown is converted to plain text first, because neither bubble draws it.

`Contacts`, in `apps/gateway/src/channels/contacts.ts`, decides who is served. The contact record is written inside the same transaction that receives the message, under the profile lock: that is what guarantees one request — and one notice — even when several messages arrive together.

`Groups`, in `apps/gateway/src/channels/groups.ts`, decides whether the profile speaks in a room already approved: it recognises the author, measures who was addressed and writes the room's budget. It runs inside the same transaction, for the same reason — the profile lock is what keeps a burst from spending the budget twice.

An answer is released a paragraph at a time, while it is still being written: the agent is told a blank line ends a message, and each completed paragraph becomes one, sent as soon as it exists. The last paragraph is the run's answer, so a run always ends with something to show and nothing is sent twice.

A delivery does not wait for the whole run. A step that says something on its way to a tool has that line sent straight away, as its own message, and the delivery counts how much of the run's commentary the chat has already received; the answer follows when the run ends. The count is raised inside the profile lock before the send, so two workers or two ticks never repeat a line — at the price of losing one to a failing adapter, which is the right way round for commentary. Between lines the chat shows only the composing indicator.

A thread between two agents is a conversation on both sides. The agent that was asked keeps one, and so does the agent that asked: what it sent and what came back are written there, or it cannot read its own half of a conversation it is in. The answer it receives is everything the colleague said that turn, not the closing paragraph alone — the rest was released as it was written and reading only the output would hand back the last line of an answer.

A message the agent sends to a contact is written into that contact's conversation, and their reply into it as well, even though another conversation is what asked for it. Without that the agent writes to someone and their own history shows nothing, which is indistinguishable from the message never having been sent.

A run the gateway starts by itself — a colleague's late answer, a contact's reply to a question the agent sent — has no incoming message to hang a delivery on, so it is given one against the conversation its session belongs to. Without that its answer reaches the transcript and stops there, which is indistinguishable from the agent having said nothing.

A delivery can exist with no run behind it: the approval notice carries its own text in `notice`. The worker sends that text directly, waiting on no run.

To add a protocol, implement the adapter, register it, and declare its type and intake in `packages/contracts`, including the HTTP route where one is needed. Regenerate the OpenAPI document and the SDK. The interface is internal; the public contract stays explicit and versionable. A protocol that signs its payload, instead of carrying a token in a header, needs a matching authentication strategy, as the Meta webhook does. Linked devices accept no webhook: their messages come only from the worker's authenticated connection. Delivery ids are numbers or strings, depending on the protocol.

## WhatsApp through a linked device

`WhatsAppChannel` uses [`baileys`](https://github.com/WhiskeySockets/Baileys), under the MIT licence. The connection behaves as a device linked by QR code; it does not use Meta's Cloud API. The library is unofficial: a change on WhatsApp's side can break the connection, and there is a risk of the account being restricted.

The worker speaks the multi-device protocol straight over a WebSocket, with no browser. Each binding opens its own socket; there is no external executable to install and no environment variable to set. A process running the API alone opens no socket.

Connecting is `POST /v1/profiles/{profileId}/channels` with `{"type":"whatsapp"}` and scanning the QR code. There is no credential to type: it comes from the pairing. The `webhookToken` of the shared contract is unused here; the channel accepts no public HTTP intake.

Every operation below needs the host token, the QR included. The base is `/v1/profiles/{profileId}/channels/{channelId}`:

| Method and path | Behaviour |
| --- | --- |
| `POST /connect` | Asks the worker to open or restore the device; answers `202` |
| `GET /connection` | State: `connecting`, `qr`, `connected`, `disconnected` or `error` |
| `GET /qr` | The payload to render a QR and how long it is valid; answered `no-store` |
| `POST /disconnect` | Invalidates the connection and deletes the encrypted session; answers `202` |

On the phone, use **Linked devices → Link a device** and scan the QR the client renders. It expires and can be replaced during pairing: read `/qr` again if you get a `409`. Never send the QR to an external generator. The gateway prints no QR, no cookie, no key and no session file in its logs.

The `connected` state means messages can be sent; `sessionSavedAt` means a recoverable backup has been persisted. The pairing credentials are written before the state becomes `connected`, and later writes are grouped over about a second. A normal shutdown flushes what is pending; an abrupt one can lose the last key rotation and require a new QR.

Sessions and the QR are encrypted with the gateway's own AES-256-GCM keyring and bound to the profile and channel through associated data. The session is serialised as JSON, capped at 64 MiB and split into authenticated parts. It exists in the clear only in the worker's memory: no session file is written to disk. The WhatsApp socket does its own communication, outside the HTTP client used for providers and MCP servers.

A lease in the database assigns the connection to one worker. The generation and the ownership counter keep an old callback or backup from restoring a session that was disconnected. Disconnecting the channel also deletes its recoverable credentials. The worker attempts the remote logout; if it is unavailable, remove the device on the phone to revoke it on WhatsApp too.

Direct and room text, image and audio messages are persisted in an inbox, deduplicated and submitted once the session is free. The inbox accepts messages from any sender, because the decision to serve comes later, at the approval of the contact or the room; there is a cap of 1,000 pending messages per channel, and reaching it stops the connection with an error. In a room the sender is the participant and the conversation is the `@g.us` JID; the protocol's mention arrives with it. The driver ignores its own messages, status updates and calls. Captionless images, voice notes, image/audio documents and stickers are received, including ephemeral wrappers. Media is limited to 16 MB per attachment. A failed download produces a readable failure notice instead of dropping the message. WhatsApp offers no cheap display name on this path, so the contact request shows the number.

Answers use the shared delivery queue. `sent` means the library confirmed the send, not that the recipient read it. A lost confirmation becomes `unknown` and triggers no automatic resend. Remote ids are strings on WhatsApp and stay numeric on Telegram.

Automated validation uses a simulated device. Pairing, restoring a session and real delivery need a worker with outbound access to WhatsApp and a phone. The local tests connect no real account.


## Profile picture

A Telegram bot and a paired WhatsApp account show their profile's picture. The worker compares each live channel with its profile every 15 seconds and uploads the picture as a 640 px JPEG when it changed, when it was removed, or when another account was paired on the channel. A channel that never showed a Jian picture is left alone while the profile has none. A refused upload is logged and offered again after 10 minutes. Only the worker holding a WhatsApp device can change its picture.

## Images and voice

### Stickers

WhatsApp does not give a paired account's saved stickers to anything outside the app, so each agent builds its own collection: every still sticker sent in a conversation the owner approved is kept once per profile, and the image-analysis model describes it and gives it three to six tags — the feeling, the reaction, the subject. Each time someone sends it again it is counted, and each time the agent sends it, that is counted too.

The agent searches with `find_stickers` by meaning, by exact tag, or by what it or the people it talks to send most; it sends one with `send_sticker`, as a sticker on WhatsApp and Telegram, and corrects tags with `tag_sticker`. The built-in `stickers` skill teaches when one fits. A profile keeps up to 200; past that, the least sent, least seen and oldest one makes room. The owner sees them under **Stickers**, with the tags the agent keeps, and can remove one. The cataloguing model declines what the agent should never send — sexual content, gore, hate symbols, a photo of a private document — and a declined or removed sticker is kept only as its fingerprint: never offered, never described again. Stickers can be switched off per profile on the same page; off, nothing is kept or described and the agent has no sticker tools. **Model defaults › Sticker analysis** picks the model that describes them, the image-analysis model when unset. Animated Telegram stickers are not kept.

### Incoming audio without a paid plan

Incoming audio is transcribed by the model chosen under **Model defaults › Incoming audio**. Gemini also describes sounds; a Whisper model only transcribes speech, which is what a voice note needs. Two Whisper routes cost nothing:

- **Groq.** Add it under **Providers** with a key from console.groq.com, then choose `whisper-large-v3-turbo` for Incoming audio. Its free tier has daily limits; check them in the Groq console.
- **A Whisper server you run.** Any server that speaks the OpenAI transcription API (`POST /v1/audio/transcriptions`) works: [speaches](https://github.com/speaches-ai/speaches) or a `whisper.cpp` server, for example. Run it beside the gateway, add it under **Providers › OpenAI-compatible server** with its address, such as `http://whisper:8000/v1`, and choose one of its Whisper models. A private address is refused unless it is allowed: set `JIAN_ALLOW_PRIVATE_ORIGINS=http://whisper:8000`. Nothing runs unless you start it, so an installation that does not use it pays nothing for it; a `small` model needs roughly 0.5–1 GB of memory while it runs.

A provider that answers 5xx — Gemini answers 503 when a model is overloaded — is asked twice more, after one and three seconds, before the audio is reported as unreadable.

WhatsApp attachments are stored per profile and conversation; unapproved direct contacts may hold four attachments until approval. Blocked contacts never reach a media model. Incoming images go directly to a vision-capable conversation model unless an auxiliary image-analysis model is selected. Text-only models receive an auxiliary description. Voice notes and ordinary audio files share the Incoming audio model. It transcribes speech verbatim and adds relevant sound context before the conversation model runs; transcription-only models preserve speech without sound analysis. Transcripts are reused rather than charged again on every step.

Agents load the `media` tool group to call `analyze_media`, `generate_image`, `list_speech_voices`, and `generate_speech`. Generation uses the installation's Model defaults. Images support OpenAI API and Gemini; speech supports OpenAI API and Gemini. Generated files appear in the session history and are queued as actual attachments on WhatsApp or Telegram. Voice replies use Opus/OGG; the Docker image includes ffmpeg to convert Gemini PCM speech. Local development needs ffmpeg for that conversion, but no local speech-recognition model is required. OpenAI API billing is separate from a ChatGPT login.

Delivery retains the existing intent/confirmation protocol: an uncertain send is not replayed. Media is read through the authenticated profile API, never a public file URL. Reported media token usage joins the run's usage; providers that report only bytes/duration cannot be represented by token counts.

This follows Hermes' split between [native/auxiliary vision](https://github.com/NousResearch/hermes-agent/blob/main/agent/image_routing.py), [transcription](https://github.com/NousResearch/hermes-agent/blob/main/tools/transcription_tools.py), and [generation tools](https://github.com/NousResearch/hermes-agent/blob/main/tools/image_generation_tool.py). Hermes also offers local Whisper; Jian's selected path uses the configured Gemini API.

Speech voice names belong to the selected speech provider, independently of the conversation model. Agents can omit `voice` for the provider default or discover supported names with `list_speech_voices`. Invalid names are rejected before sending text to a provider. The optional `instructions` field controls delivery style on Gemini and modern OpenAI speech models; legacy OpenAI TTS models require it to be omitted.

Channel operations emit JSON records with `component`, `event`, `level`, `time`, and applicable internal channel/run/delivery IDs and status. Error records allow only HTTP status and known network error codes; they omit raw exceptions, chat contents, recipient addresses, tokens and binary payloads. The WhatsApp protocol logger remains disabled, and direct libsignal session dumps are suppressed; decryption diagnostics become metadata-only events.

Incoming image routing loads model capabilities before choosing native vision, including after a restart. Images use the SDK file format and retain their pixel token allowance. Auxiliary vision retries transient provider failures twice with backoff; authentication and other permanent errors are not retried. Failure after retries is reported without pretending the image was read.
