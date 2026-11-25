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
