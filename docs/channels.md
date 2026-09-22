# Channels

A profile has three possible channels — WhatsApp, Telegram and the API server — and at most one of each. Connecting is the whole configuration: there is no name, no chosen session and no list of senders. Who may talk to the agent is decided afterwards: contact by contact in private conversations, and once per room in groups.

`POST /v1/profiles/{profileId}/channels` connects a type and returns the `webhookToken` once; the database keeps only its hash. A second channel of the same type answers `409`. `DELETE /v1/profiles/{profileId}/channels/{channelId}` disconnects, deletes the channel's secret from the vault and frees the type for a new connection. Approved contacts and their conversations are kept.

## Contacts and approval

The first message from an unknown sender does not enter the profile. The gateway records a contact request with who wrote and what they said, tells the person once that the owner has to approve, and holds the message.

| Method and path | Behaviour |
| --- | --- |
| `GET /v1/profiles/{profileId}/contacts` | Pending requests first, then approved and blocked |
| `POST /v1/profiles/{profileId}/contacts/{contactId}/approve` | Opens the conversation's session and releases the held message |
| `POST /v1/profiles/{profileId}/contacts/{contactId}/block` | Discards the message and ignores the sender silently |

All of them need the host token: approving is granting access to the agent.

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

A room is a conversation where several people and several agents write. Each agent joins through its own connection — its own number on WhatsApp, its own bot on Telegram — so the isolation between profiles stays whole: each profile sees the room through its connection, and what the other agents write reaches it as a message from another participant, over the protocol itself. There is no shared room and no common transcript inside the gateway.

The channel marks the conversation: `scope: "group"`. On WhatsApp that is a `@g.us` JID, with the participant as the sender and the room as the conversation; on Telegram it is the `group` and `supergroup` chats. A room message becomes a session of the profile identified by the room, and the run receives the author along with the text — `Lucas: Ada, can you look at the report?` — because in a room the agent has to know who spoke to answer them.

### Approval is per room

The owner approves the room once, not each participant. The request records the conversation, and whoever writes there later comes in under the same decision.

- A pending room starts no run, produces no delivery and receives no automatic notice: the gateway does not write inside a room the owner has not approved, not even to explain that it is waiting.
- Nothing is held. In a private conversation the first message waits for approval and is released afterwards; in a room it is not kept, because releasing it would make the agent answer a message that named nobody.
- Each profile sees the room through its own connection, so each has its own request and its own session. Approving for one profile approves for none of the others.
- Renaming the room does not reopen the request; the new name updates the title.

### Only the agent addressed answers

In a room where more than one agent of the installation is approved, an agent stays quiet by default and answers only when it is addressed. Without that, three agents answer the same message and the room becomes noise. An agent knows it was called in two ways:

- A protocol mention of its own connection's address, where the protocol carries one — `mentionedJid` on WhatsApp, `text_mention` on Telegram.
- The profile's name written in the message, compared without case or accents and respecting word boundaries. A compound name also answers to its first name, at three letters or more.

A message from another agent always has to address the agent. A message from a person needs the name when more than one agent is approved in the room; with a single agent there is nobody to talk over, and it answers as it would in private.

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

Send `actorId`, `chatId`, `text`, `requestKey` and, if you have it, `displayName` to `POST /v1/ingress/{channelId}`, using `X-Jian-Channel-Token`. For a room, send `scope: "group"` with the room's `chatId`, the `actorId` of whoever wrote and, if you have them, `groupName` and `mentions`. The adapter that calls this route must authenticate the external identity before filling the ids in; whoever holds the token can represent any sender, and each new sender becomes a contact request. The answer carries `accepted`, the run id when there is one, and the contact's state. Read results through the admin API.

This channel sends no answer back to an external service. Turning it into an OpenAI-compatible endpoint is a task of its own; what is described here is the intake as it stands.

## Telegram

1. Connect the channel with `type: "telegram"` and the BotFather token in `botToken`. The gateway encrypts the token in the vault under `channel:<id>`; it comes back in no response. To change it, disconnect and connect again.
2. The gateway calls `setWebhook` immediately with `https://<host of the request>/v1/telegram/{channelId}`, the `webhookToken` as `secret_token`, and `allowed_updates` limited to `message`. The response carries `webhookRegistered`. If it comes back `false` — a gateway on `localhost`, a port Telegram refuses, or Telegram being down — the channel stays connected and the registration can be done by hand with the same values.

The gateway validates `X-Telegram-Bot-Api-Secret-Token` and the contact before accepting a message. A redelivery of the same update recovers the same run. The finished answer is sent as separate messages, split where the agent left a blank line, in plain text with no parse mode. The settings follow the [official Telegram API](https://core.telegram.org/bots/api#setwebhook).

This implementation handles text messages from users with `from`, `chat` and `text`, in private conversations and in rooms; media, edits, callbacks and forum topics are not implemented. `first_name` or `username` becomes the display name on the contact request. In a room, `chat.title` becomes the room name and `text_mention` entities become mentions. For a bot to see the room messages that do not mention it, turn privacy mode off in BotFather.

Under flood control Telegram answers 429 with a wait; the gateway honours it, keeps the delivery queued and stops trying until that moment passes. A delivery that confirmed nothing is repeated; one that partly landed never is.

The worker processes deliveries once the run has finished. `GET /v1/profiles/{profileId}/deliveries` shows `pending`, `sending`, `sent`, `failed` or `unknown`. An uncertain failure is not repeated on its own; read the confirmed message ids before acting by hand.

The host comes from the `Host` header of the connect request, so connect through the public domain, not an internal address. The local tests simulate Telegram and configure no real bot.

## Adapters

Each protocol implements `Channel`, in `apps/gateway/src/channels/channel.ts`. `ApiChannel` normalises HTTP intake; `TelegramChannel` reads updates and sends answers. `WhatsAppChannel` uses the linked-device connection the worker keeps. `ChannelRegistry` picks the adapter by type, so the `Channels` service branches on no protocol.

The interface defines the optional webhook authentication header, the intake normalisation, the optional send and the optional typing indicator. The absence of `send` means the channel only receives: the API server produces no fictitious delivery and no approval notice. Credentials and the guarded HTTP client are handed to an adapter only while it sends.

The shared service keeps the shared guarantees: token authentication, the contact decision, binding to a profile and a session, deduplication, recording the delivery and recovering uncertain states. Adapters choose no permissions and touch no database. Before sending, the service writes `sending` in a transaction; if it loses the confirmation it records `unknown` rather than repeating a possible outside effect.

An answer reaches a chat as the messages it was written in, split where the agent left a blank line, with the composing bubble and a short pause between them. Markdown is converted to plain text first, because neither bubble draws it.

`Contacts`, in `apps/gateway/src/channels/contacts.ts`, decides who is served. The contact record is written inside the same transaction that receives the message, under the profile lock: that is what guarantees one request — and one notice — even when several messages arrive together.

`Groups`, in `apps/gateway/src/channels/groups.ts`, decides whether the profile speaks in a room already approved: it recognises the author, measures who was addressed and writes the room's budget. It runs inside the same transaction, for the same reason — the profile lock is what keeps a burst from spending the budget twice.

A delivery does not wait for the whole run. A step that says something on its way to a tool has that line sent straight away, as its own message, and the delivery counts how much of the run's commentary the chat has already received; the answer follows when the run ends. The count is raised inside the profile lock before the send, so two workers or two ticks never repeat a line — at the price of losing one to a failing adapter, which is the right way round for commentary. Between lines the chat shows only the composing indicator.

A delivery can exist with no run behind it: the approval notice carries its own text in `notice`. The worker sends that text directly, waiting on no run.

To add a protocol, implement the adapter, register it, and declare its type and intake in `packages/contracts`, including the HTTP route where one is needed. Regenerate the OpenAPI document and the SDK. The interface is internal; the public contract stays explicit and versionable. A protocol that signs its payload, instead of carrying a token in a header, will need an authentication strategy to match. Linked devices accept no webhook: their messages come only from the worker's authenticated connection. Delivery ids are numbers or strings, depending on the protocol.

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

Direct and room text messages are persisted in an inbox, deduplicated and submitted once the session is free. The inbox accepts messages from any sender, because the decision to serve comes later, at the approval of the contact or the room; there is a cap of 1,000 pending messages per channel, and reaching it stops the connection with an error. In a room the sender is the participant and the conversation is the `@g.us` JID; the protocol's mention arrives with it. The driver ignores its own messages, status updates, media and calls. WhatsApp offers no cheap display name on this path, so the contact request shows the number.

Answers use the shared delivery queue. `sent` means the library confirmed the send, not that the recipient read it. A lost confirmation becomes `unknown` and triggers no automatic resend. Remote ids are strings on WhatsApp and stay numeric on Telegram.

Automated validation uses a simulated device. Pairing, restoring a session and real delivery need a worker with outbound access to WhatsApp and a phone. The local tests connect no real account.
