# jian (Rust gateway)

The Jian gateway as one binary, with its own Postgres 18 inside. It serves `GET /health`,
`GET /v1/me` and two WebSockets, behind bearer tokens. There is no panel yet.

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

The owner token is `JIAN_API_TOKEN` / `--api-token` when set (at least 32 characters). Otherwise it
is generated on the first start into `owner.token` in the data directory (mode 0600 on Unix) and
reused after; `make rust-dev` uses `.jian-dev/owner.token`. The log names the file, never the
token. Machine and device tokens are issued, listed and revoked by the owner over `/v1/ws`; a token
is shown once. A missing or wrong token gets a bare 401, a token of the wrong kind a 403, and
guessing from one address is slowed down with a 429 and `Retry-After`.

## Talk to it

```bash
curl -i http://127.0.0.1:4410/health
# {"status":"ok","database":"up"}   (503 and "unavailable" when the database does not answer)
curl -H "Authorization: Bearer $(cat .jian-dev/owner.token)" http://127.0.0.1:4410/v1/me
# {"tenant":"local","kind":"owner","subject":null}
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
`--database-url` / `DATABASE_URL`.

```bash
make rust-dev DATABASE_URL=postgres://user:pass@127.0.0.1:5432/jian
```

With a URL the embedded Postgres is not started and `.jian-dev/` is not used. The user must be able
to create roles (`CREATEROLE`) and own the database, because each tenant gets a schema and a role.
A `DATABASE_URL` already exported in your shell is used the same way.

```bash
cargo run -p jian -- --addr 127.0.0.1:9000 --data-dir ./my-data
```
