---
name: contracts-and-migrations
description: Use when changing an HTTP route, a request or response shape, or the database schema in Jian.
---

# Contracts and migrations

## The HTTP contract

Zod schemas in `packages/contracts/src` are the single source; each route has an entry in
`operations.ts`.

1. Change the schema or add the operation. Path parameters are UUIDs unless the operation gives
   its own `params`.
2. Run `pnpm contracts:generate`, which writes the OpenAPI document and the client. `pnpm dev`
   does this on save, and a commit touching the schemas regenerates and stages the outputs.
3. Never edit a generated file. `pnpm contracts:check` fails when one is stale.
4. If the panel's typecheck cannot see the change, run `pnpm --filter @jian/sdk build`.

Every operation states its `access`. Test that an owner route refuses a caller with no token.

## Migrations

Files live in `apps/gateway/migrations`, with `meta/_journal.json` beside them.

- `make db-migration` writes one from what changed in `apps/gateway/src/storage/schema.ts`.
- A hand-written one needs its journal entry, with a `when` later than the last.
- Published migrations are immutable. A later change gets a new version.
- A `text` column with a `$type` has no database check, so a new value needs no migration.

Run the persistence tests with `TEST_DATABASE_URL` when a query changes shape.
