# jian (Rust gateway)

The Jian gateway as one binary, with its own Postgres 18 inside. It serves `GET /health`,
`GET /v1/me`, the sign-in, members and invitations routes and two WebSockets, behind bearer tokens. There is no panel yet.

## Run it for development

```bash
make rust-dev
```

It builds `bins/jian`, starts it on `127.0.0.1:4410` and prints the routes it serves. The first
start unpacks Postgres and creates the cluster, so it takes longer than the next ones.

- **Data** lives in `.jian-dev/` at the repository root (git-ignored): `pgdata/` is the cluster,
  `postgres/` the unpacked server, `password` the superuser's password (mode 0600).
- **Migrations** run at every start, and the single tenant of the install is created once.
- **Restart on change**: with [`cargo-watch`](https://crates.io/crates/cargo-watch) installed
  (`cargo install cargo-watch --locked`) the gateway rebuilds and restarts when `crates/`,
  `bins/` or a manifest changes. Without it, `make rust-dev` says so and runs plain `cargo run`.
- **Logs** follow `RUST_LOG`, `info,sqlx=warn,jian=debug,jian_server=debug,jian_store=debug` by default:
  `RUST_LOG=trace make rust-dev`.
- **Reset**: `make rust-dev-reset` stops the Postgres of `.jian-dev/` if it is up and deletes
  that directory, nothing else.
- **After a crash**: if the gateway is killed (`kill -9`, an out-of-memory kill, a restart by
  `cargo watch`), its Postgres keeps running. The next start finds it through
  `pgdata/postmaster.pid`, stops it cleanly (`pg_ctl stop -m fast`) and goes on, or deletes the
  file when that server is gone. It never signals a process that is not the Postgres of that
  data directory.

## Master key for secrets

Provider keys, OAuth tokens and channel credentials are stored encrypted (AES-256-GCM, one data
key per tenant, itself encrypted by a master key). Where the master key comes from, first match
wins:

| Variable | Format |
| --- | --- |
| `JIAN_MASTER_KEYS` + `JIAN_ACTIVE_KEY_ID` | JSON `{"<keyId>": "<base64 of 32 bytes>"}`, as the Node Jian takes it. The active id may be left out when the list has one key. |
| `JIAN_MASTER_KEY` | One key, the base64 of 32 bytes, with the key id `local`, as the desktop app takes it. |
| none | `master.key` in the data directory, generated on the first start (mode 0600 on Unix) and reused after. `make rust-dev` uses `.jian-dev/master.key`. |

The log names the key ids, never a key. **Back the key up with the database**: without it the
secrets cannot be read, and a lost `master.key` is not recoverable.

Rotate the master key: add the new key to `JIAN_MASTER_KEYS`, make it active with
`JIAN_ACTIVE_KEY_ID`, and run `jian keys rotate`. It rewraps the data keys only (the secrets do not
change), in batches, and prints how many; run it again and it changes nothing. Then remove the old
key. With the embedded Postgres, stop the gateway first, because the command starts that database
itself; with `DATABASE_URL` it can run beside the gateway.

## Tokens

Every request except `/health` carries `Authorization: Bearer <token>`. The token alone says which
tenant it is; nothing else (header, query, body) is read for that. The database keeps only the
SHA-256 of a token.

| Prefix | Who | Where |
| --- | --- | --- |
| `jo_`... (any string of 32+ characters for the owner) | the owner | `/v1/ws`, `/v1/me` |
| `jrm_` | a machine's worker | `/v1/machines/connect` |
| `jd_` | a phone or other device | `/v1/ws` (cannot issue tokens) |
| `js_` | a person who signed in with a password | `/v1/ws`, `/v1/me`, `/v1/auth/*`, and `/v1/members` and `/v1/invites` for an admin; see [People](#people) |

The owner token is `JIAN_API_TOKEN` / `--api-token` when set (at least 32 characters). Otherwise it
is generated on the first start into `owner.token` in the data directory (mode 0600 on Unix) and
reused after; `make rust-dev` uses `.jian-dev/owner.token`. The log names the file, never the
token. Machine and device tokens are issued, listed and revoked by the owner over `/v1/ws`; a token
is shown once. A missing or wrong token gets a bare 401, a token of the wrong kind a 403, and
guessing from one address is slowed down with a 429 and `Retry-After`.

## People

A person is one **account** (one per email address, with its own name and password) and a
**member** of each workspace they belong to, with a role there (`admin` or `member`). The
gateway has **no sign-up**: an account exists because an admin, the owner's token or the command
line added it, or because an invitation was accepted. A session opens one workspace. A
self-hosted install has one workspace; the Cloud has many, and an account may be in several.
Agents, conversations and memories are not a member's yet.

## Cargo capabilities

`jian` profiles compose capabilities; `public-url` is configuration, not a Cargo feature. The
local profile includes `mcp-http` and `mcp-stdio`, but not channels, extra users, public artifact
links, e-mail sign-in, GitHub sign-in/App, or webhook ingress. Server profiles add these
capabilities explicitly:

| Profile | Capabilities |
| --- | --- |
| `local` | `mcp-http`, `mcp-stdio`, `local-process` |
| `self-hosted` | `local` plus `channels`, `multi-user`, `public-artifacts`, `email-login`, `email-invitations`, `github-login`, `github-app`, `linear-webhooks`, `channel-webhooks`, `slack-events-api` |
| `cloud` | Server capabilities except `mcp-stdio` and `local-process`; adds `multi-tenant` |

`channels` controls channel providers and their authenticated routes; `channel-webhooks` and
`slack-events-api` independently add inbound HTTP delivery. `mcp-http` is outbound MCP
Streamable HTTP, while `mcp-stdio` runs a command on the gateway machine. The `--public-url`
setting supplies a canonical external address to whichever enabled capability needs links or
callbacks; it does not enable those capabilities.

The user and e-mail routes below require `multi-user`, `email-login`, or `email-invitations` as
appropriate, and are absent from the local profile. This reference describes the self-hosted
profile unless a route or flag is identified as capability-gated.

The first admin comes from the command line, because there is nobody to ask yet. The password is
read from standard input so it is not in the process list or the shell history, and with the
embedded Postgres the gateway must be stopped first (the command starts that database itself),
after it has run once so that the database and the workspace exist:

```bash
printf '%s\n' 'a password of twelve or more' | \
  cargo run -p jian -- --data-dir .jian-dev users add --email admin@example.com --admin --password-stdin
cargo run -p jian -- --data-dir .jian-dev users list
```

The first member must be an admin and keeps the password given; later ones get a provisional
password they must replace at their first sign-in. `users add --invite` makes an invitation
instead: a link when `--public-url` is set, a token when not, shown once, that works once for seven
days. This command never sends e-mail (it does not run the job queue, and the admin at the
keyboard can hand the link over); sending is `POST /v1/invites`. `users disable --email ...` ends
that member's sessions here, and `users reset-password --email ... --password-stdin` sets a
provisional password. The owner's token also adds members over HTTP, so an install can get its
first admin without the command line: `POST /v1/members`.

```bash
curl -s -H 'Content-Type: application/json' http://127.0.0.1:4410/v1/auth/login \
  -d '{"email":"admin@example.com","password":"a password of twelve or more"}'
# {"token":"js_...","expiresAt":"...","tenant":"local","member":{"accountId":"acc_...","role":"admin",...}}
curl -H "Authorization: Bearer $SESSION" http://127.0.0.1:4410/v1/me
# {"tenant":"local","kind":"session","subject":"acc_...","accountId":"acc_...","role":"admin","mustChangePassword":false}
```

| Route | Who | What |
| --- | --- | --- |
| `POST /v1/auth/login` | nobody yet | `{email, password, tenant?}` gives a session of 30 days; `tenant` is needed only when the account is in several workspaces (`400 tenant_required`) |
| `POST /v1/auth/logout` | a session | ends that session |
| `POST /v1/auth/password` | a session | `{current, new}`; every other session of the account ends, in every workspace |
| `POST /v1/auth/invite/accept` | nobody yet | `{token, password, name?}`: a new address chooses its password; an existing account gives its current one, which stays |
| `GET /v1/members`, `POST /v1/members` | an admin or the owner's token | list; add with a provisional `password` (ignored when the account exists) |
| `POST /v1/members/{account_id}/disable` | an admin or the owner's token | cannot open this workspace; its sessions here end at once, not those in other workspaces |
| `POST /v1/members/{account_id}/reset-password` | an admin or the owner's token | `{password}`, provisional; `409 account_in_other_workspaces` when the account is in another workspace too |
| `GET /v1/invites`, `POST /v1/invites` | an admin or the owner's token | pending ones, each with `sendStatus` (`none`, `pending`, `sent`, `failed`), `sendError`, `sentAt`, `providerMessageId`; `{email, role, send?}` makes one (`send` defaults to yes when e-mail and a public URL are set up) and a new one for the same address revokes the old. Sent: `201` without a token, the job e-mails it. Not sent: `201` with the `token` and the `link`, once |
| `POST /v1/invites/{id}/link` | an admin or the owner's token | copy the link: a new token for the same invitation, the old one (also the one in an e-mail already sent) stops working; the link comes once |
| `POST /v1/invites/{id}/resend` | an admin or the owner's token | `202`: kills the current token and queues an e-mail with a new one |
| `POST /v1/invites/{id}/revoke` | an admin or the owner's token | the token stops working |
| `GET`, `PUT`, `DELETE /v1/settings/mail` | an admin or the owner's token | the workspace's own Resend account, see [E-mail](#e-mail) |

## E-mail

E-mail is only transactional, from the platform: today the invitation. It is not the agents'
mailbox. The link is always available, so an invitation works with no e-mail at all.

| Flag | Variable | What |
| --- | --- | --- |
| `--public-url` | `JIAN_PUBLIC_URL` | Where the panel is on the internet (`https://jian.example.com`; http or https, no user, query or fragment). The link is `<url>/invite#token=<token>`: the token is in the fragment so a browser never sends it to a server, a proxy log or a `Referer`. Without it, `send` and `/link` are `409 public_url_missing` and an invitation is a token only |
| `--mail-resend-key` | `JIAN_RESEND_API_KEY` | The **deploy's** Resend key, for a hosted deployment: it sends for every workspace, and no workspace can read or change it. Needs `--mail-from` |
| `--mail-from` | `JIAN_MAIL_FROM` | The deploy's sender, `name@example.com` or `Name <name@example.com>`, on a domain verified at Resend |
| `--workspace-name` | `JIAN_WORKSPACE_NAME` | What the e-mail calls the workspace (`Jian`); workspaces have no name of their own yet |

Which account sends, first match wins: the deploy's (`--mail-resend-key`), then the workspace's
own, then none. A self-hosted install uses its own: an admin sets it with
`PUT /v1/settings/mail {"resendApiKey": "re_...", "from": "Name <name@example.com>"}`, which
keeps the key in the workspace's encrypted vault (leave `resendApiKey` out to change only the
sender); `GET` says the provider, the sender and whether a key is stored, never the key;
`DELETE` forgets both. When the deploy has an account, `GET` says `managedByDeploy` and `PUT` and
`DELETE` are `409 mail_managed_by_deploy`. `send: true` with no account is `409 mail_not_configured`.

Sending is a job (`invite.send`) with the invitation's id as its whole payload. It makes a new token,
e-mails the link and records the result on the invitation. A refusal that waiting cannot fix (an
invalid key, a sender Resend has not verified) ends as `sendStatus: failed` with the reason and no
retry; a provider outage or a network error is retried by the queue, and `failed` when the
attempts run out. Fix the cause and `resend`. Copying the link while an e-mail is on its way kills
that e-mail's token: the person who clicks it is told it is no longer valid, and the admin
holds the working link. E-mail has no exactly-once, so a message delivered before a timeout can
arrive twice, and only the last carries a working link.

An id of another workspace is a `404`, word for word what an id that never existed gets. An
address is stored trimmed and in lower case. A password has 12 characters at least and 256 bytes
at most, and is kept as an argon2id hash (19 MiB, 2 passes, 1 lane). A wrong password, an
unknown address, a disabled member, an account that is not in the workspace asked for and a
malformed address all get the same `401 invalid_credentials`, and cost the same time. Guessing
is slowed three ways (`429`, `Retry-After`): per network address, per email address from anyone
(20 tries, then one every 30 seconds), and per email address and network address together (five
tries, then one a minute). The per-email limit means someone who knows an address can lock it
out for a while; that is the price of stopping a guesser who changes address. A session whose
password an admin chose can call only `/v1/me`, `/v1/auth/password` and `/v1/auth/logout` until
it changes it. A session is an opaque token whose SHA-256 is all the database keeps.

`--auth-methods` (`JIAN_AUTH_METHODS`) says how people may sign in: a comma-separated list of
`password`, `github`, `email_link`, `passkey` and `totp`, `password` by default. `password`,
`github` and `email_link` are implemented. Leaving `password` out is the "password off" switch:
the login and invitation routes answer 404. Whatever is allowed, GitHub and the e-mailed link only
let in people who are already members; nobody signs themselves up.

`github` needs `--public-url` and `--github-client-id` / `--github-client-secret`
(`JIAN_GITHUB_CLIENT_ID`, `JIAN_GITHUB_CLIENT_SECRET`), an OAuth App whose callback URL is
`<public-url>/login/github`; the secret is held in memory and sent only to GitHub's token endpoint.
`email_link` needs `--public-url` and a way to send e-mail (`--mail-resend-key` and `--mail-from`,
or the workspace's own Resend account); `--mail-log` writes e-mails to the log instead, for a
laptop. The panel's pages `/login/github` and `/login/link` hand the `code`, `state` and `token`
they receive to `/v1/auth/github/callback` and `/v1/auth/magic-link/redeem`. The owner and device tokens work either way. The crate
`jian-auth` has the sign-in flows with no HTTP, for a backend that serves them itself.

## Import from the old Jian

The old Node Jian's owner, secrets, machines and phones come over into the install's workspace. It
only reads the old data. Everything else the old one held (conversations, agents, memories...) is
listed with its row count and waits for the core to have a table for it.

```sh
# Stop the gateway first when it uses the embedded Postgres.
jian import --from old.sql --import-master-key <base64> --import-owner-email me@example.com
jian import status
```

- Source: a `.sql` dump made with `pg_dump` (the desktop app's PGlite database is not a native
  Postgres, so it is exported to a dump first; see the `jian-import` crate docs), or the old
  gateway's `postgres://` URL.
- Keys: `--import-master-key` / `JIAN_IMPORT_MASTER_KEY` (the desktop app's key),
  `--import-master-keys` / `JIAN_IMPORT_MASTER_KEYS` (the server's JSON). Without them the
  secrets are skipped. The desktop app's `local-gateway.json` is read when its key is not sealed.
- Owner: the old Jian keeps no e-mail, so `--import-owner-email` / `JIAN_IMPORT_OWNER_EMAIL`
  makes that address the first admin, with no password; set one with `jian users reset-password`.
- At start, `--import-from` / `JIAN_IMPORT_FROM` (or an `export.sql` in the old desktop folder)
  imports the domains not done yet. A failure is logged and never stops the start. Running again
  never duplicates and never overwrites a row.

## Talk to it

```bash
curl -i http://127.0.0.1:4410/health
# {"status":"ok","database":"up"}   (503 and "unavailable" when the database does not answer)
curl -H "Authorization: Bearer $(cat .jian-dev/owner.token)" http://127.0.0.1:4410/v1/me
# {"tenant":"local","kind":"owner","subject":null,"accountId":null,"role":null,"mustChangePassword":false}
```

`/v1/ws` speaks the client protocol of `jian-protocol` (`ClientMessage` / `ServerMessage`,
TypeScript types in `packages/protocol`). Without a panel, try it with the example client, which
issues a machine (third argument) and lists the machines:

```bash
cargo run -p jian-server --example ws_client -- 127.0.0.1:4410 .jian-dev/owner.token my-laptop
```

Give the printed machine token to a worker (`jian-remote`, gateway `http://127.0.0.1:4410`) and
run the example again without the name: the machine is `online`. With `websocat` the bearer goes
in a header, `websocat -H "Authorization: Bearer $TOKEN" ws://127.0.0.1:4410/v1/ws`, and the first
message is `{"type":"hello","protocolVersion":1}`. A browser cannot set that header; the panel's
own login comes later.

## Slots, several instances and stopping

Tenants are spread over 1024 fixed slots by a stable hash of their id, and each slot is leased to
one gateway instance at a time (`platform.slot_leases`, a 30 s lease renewed every 10 s, timed by
the database's clock). No two instances serve a tenant at once. A self-hosted install is one
instance that takes all 1024 slots when it starts, in one statement; the log says
`slots ... held=1024 target=1024 instances=1`.

- **A second instance** on the same database takes its half: the first lets go of up to 128 slots
  per renewal until each holds 512, and a socket of a tenant that moves is closed with code `4004`
  (reconnect). Both instances need the same master key and owner token, because each start writes
  the owner token it knows:

  ```bash
  JIAN_API_TOKEN=$(cat .jian-dev/owner.token) JIAN_MASTER_KEY=$(cat .jian-dev/master.key) \
    cargo run -p jian -- --addr 127.0.0.1:4411 --data-dir .jian-dev-2 \
    --database-url postgres://postgres:$(cat .jian-dev/password)@127.0.0.1:<port>/postgres
  ```

  `<port>` is the fourth line of `.jian-dev/pgdata/postmaster.pid`. Delete `.jian-dev-2/` after.
- **A socket for a tenant this instance does not serve** is closed at once with `4004`. Nothing
  routes it to the right instance yet (the edge router is M6): behind a load balancer the client
  just reconnects until it lands on the owner. The Jian Remote worker already retries with its
  backoff after any close it was not told to give up on, and `4004` is not one of those.
- **An instance that dies** stops renewing, and its slots are taken by another one when the lease
  runs out (up to 30 s). It stops serving them before that, on its own monotonic clock.
- **SIGTERM / SIGINT** drains: the instance stops serving tenants (open sockets get `4004`) and
  taking jobs, stops accepting, waits up to 8 s for the jobs that are running, stops the ones
  still running and puts them back in the queue, releases its leases so another instance takes
  the slots on its next round without waiting, and only then stops the embedded Postgres. The log
  shows each step: `stop signal received; draining`, `no longer serving tenants`,
  `job runner stopped aborted=<n>`, `slot leases released released=<n> requeued=<n>`,
  `embedded Postgres stopped`.

## The job queue

Work that must survive a restart (runs, schedules, channel deliveries, webhooks) is a row in
`platform.jobs`, in the same Postgres, and nothing else: no Redis, no separate queue. Each
instance runs the jobs of the slots it owns, so a tenant's jobs and its sockets are on one
instance.

- A job has a `kind` (`run.start`, `channel.deliver`), a JSON `payload` of **ids and small
  parameters, never a secret**, an optional **idempotency key** (the same key for the same tenant
  and kind is one job, also after it ran, until its `done` row is cleaned up) and `max_attempts`
  (default 5).
- Failure: the handler returns a retryable error and the job waits `5 s * 2^(attempt-1)`, capped
  at 15 minutes, lowered by up to half at random, then runs again; after the last attempt, or at
  once for a permanent error, it is `dead` and stays for inspection. A job whose instance dies is
  taken back when its 60 s deadline passes (a slow handler keeps it with a heartbeat every 20 s);
  a late answer from the instance that lost the job is refused.
- The queue is **at-least-once**: a handler's effect must be safe to repeat.
- `done` jobs are deleted after 7 days. Jobs of the old Node gateway's pg-boss are not imported.
- The instance wakes on a Postgres `NOTIFY` when a job is enqueued and polls every second as a
  guarantee (this also takes back the jobs of dead instances). It runs 4 jobs at a time.

**Registering a handler** (for the domains, from M3): implement `jian_server::JobHandler` for a
kind, add it to the `JobRegistry` the binary passes to `JobRunner::start`, and enqueue with
`Database::enqueue_job(&tenant, NewJob::new("kind", json!({ "id": id })).idempotent(key))`. An
instance claims only the kinds it has a handler for. The module docs of `jian-server`'s `jobs`
have an example. Until a domain has one, the binary registers a single `debug.log` kind.

**Try it**: with `make rust-dev` running, enqueue a job on its Postgres (the port is the fourth
line of `.jian-dev/pgdata/postmaster.pid`) and read the gateway's log:

```bash
cargo run -p jian -- --data-dir .jian-dev jobs enqueue-test --message hello --work-ms 3000 \
  --database-url postgres://postgres:$(cat .jian-dev/password)@127.0.0.1:<port>/postgres
# enqueued job 0b0e...
# gateway log: debug job started ... debug job finished
```

Without `--database-url` the command starts the embedded Postgres itself, so the gateway must be
stopped first. `--work-ms` keeps the job running long enough to `kill -TERM` the gateway and see
it handed back (`requeued=1`).

## Another address or another Postgres

Flags, each with an environment variable: `--addr` / `JIAN_ADDR`, `--data-dir` / `JIAN_DATA_DIR`,
`--database-url` / `DATABASE_URL`, `--auth-methods` / `JIAN_AUTH_METHODS` (`password` by default).

```bash
make rust-dev DATABASE_URL=postgres://user:pass@127.0.0.1:5432/jian
```

With a URL the embedded Postgres is not started and `.jian-dev/` is not used. The user must be able
to create roles (`CREATEROLE`) and own the database, because each tenant gets a schema and a role.
A `DATABASE_URL` already exported in your shell is used the same way.

```bash
cargo run -p jian -- --addr 127.0.0.1:9000 --data-dir ./my-data
```
