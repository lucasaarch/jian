# jian (Rust gateway)

The Jian gateway as one binary, with its own Postgres 18 inside. Today it serves `GET /health`
only: no panel, no authentication and no WebSocket yet, so there is no token to find.

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

## Talk to it

There is no UI. The gateway has one route:

```bash
curl -i http://127.0.0.1:4410/health
# {"status":"ok","database":"up"}   (503 and "unavailable" when the database does not answer)
```

There is no WebSocket endpoint yet. When it exists it will be reachable like this:

```bash
websocat ws://127.0.0.1:4410/<path>
```

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
