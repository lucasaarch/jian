# Jian

Self-hosted agent gateway. One trusted owner per installation, isolation per profile.
TypeScript on Node 24+, Fastify, PostgreSQL, pg-boss. Native Apple client in Swift.

## Layout

```text
apps/gateway/       HTTP API, runtime, workers, tests
apps/gateway-ui/    Next.js panel, statically exported into the gateway
apps/apple/         Jian, one SwiftUI target for iOS and macOS
packages/contracts/ Zod schemas — the source of the HTTP contract
packages/sdk/       Generated TypeScript client
docs/               Architecture, security, channels, panel
```

Products share contracts, never each other's internals.

## Commands

The Makefile is the entry point; `make` alone lists every target. It delegates — pnpm owns
the Node work, Docker the containers, Xcode the Apple side.

```bash
make install     # pnpm install --frozen-lockfile
make setup       # writes .env (0600) with local credentials; never prints secrets
make db-up       # development PostgreSQL on 127.0.0.1:5432
make dev         # gateway on :4310 and the panel with hot reload on :3000
make check       # lint, typecheck, unit tests, build, contract drift
make up          # production stack: published image plus its own PostgreSQL
make apple-test  # JianKit unit tests
make apple-lint  # SwiftLint, strict
make release VERSION=1.2.3  # after writing docs/releases/1.2.3.md; tags and publishes
```

`package.json` keeps only the Node scripts. Anything that shells out to Docker or Xcode
lives in the Makefile, so there is one place to look and one place to change.

## Generated code

Zod schemas in `packages/contracts/src` are the single source. `pnpm contracts:generate`
writes the OpenAPI document and the TypeScript client; the Swift package reads the same
document through a symlink and regenerates its types on every Xcode build. Never edit a
generated file, and never hand-patch the Swift output — fix the schema instead.
`pnpm contracts:check` fails when a generated file is stale.

Running it by hand is rarely needed: `pnpm dev` regenerates on every save of a schema and
recompiles the client, and a commit that touches `packages/contracts/src` regenerates and
stages the outputs before it lands.

## Conventions

Biome formats and lints the TypeScript side: two spaces, single quotes, semicolons, 100
columns. SwiftLint covers the Swift side. Both run on staged files before a commit.

Comments explain why a rule exists, what it guarantees, its units and its traps. They do
not narrate what the code already says. Keep modules small and responsibilities named.

Test authorization, isolation, persistence, concurrency, delivery and failures with
external effects. Do not write tests that mirror the implementation, count internal calls
or chase coverage. Use synthetic credentials only.

Published migrations are immutable; a later change gets a new version.

## Traps

- The panel served at `:4310/ui/` is the copy from the last `pnpm build`. Edits show up on
  `:3000` only.
- PostgreSQL applies `POSTGRES_PASSWORD` only when the volume is first created. A
  recreated `.env` then fails with `28P01`; `ALTER USER` fixes it without losing data.
- Unit tests need no Docker and no provider. Persistence tests need `TEST_DATABASE_URL`.
- Configuring CI is not running it. Never report verification that did not happen.
