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
