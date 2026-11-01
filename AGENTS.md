# Jian

Self-hosted agent gateway. One trusted owner per installation. Memories, conversations and identity
are per agent; files are shared.
TypeScript on Node 24+, Fastify, PostgreSQL, pg-boss.

```text
apps/gateway/         HTTP API, agent runtime, workers
apps/web/             Next.js host of the panel, in front of the gateway
apps/desktop/         Electron host of the panel, with its local gateway and native browser
apps/remote-control/  Published npm worker, the CLI around remote-core
packages/ui/          Every screen, the glass kit, styles and client, for both hosts
packages/remote-core/ The machine worker: polling, shell, Computer Use, native helpers
packages/contracts/   Zod schemas, the source of the HTTP contract
packages/sdk/         Generated client
docs/releases/        One note per release; the only documentation kept
.agents/skills/       How to do the detailed work below
```

Products share contracts, never each other's internals.

## Commands

`make` lists every target, and anything that touches Docker lives there.

```bash
make install && make setup   # dependencies, then .env with local credentials
make db-up && make dev       # gateway on :4310, panel on :3000
pnpm --filter @jian/desktop dev --watch   # the desktop app; a main process change restarts it
make check                   # everything CI checks, slowly
make release VERSION=1.2.3   # only when asked; needs docs/releases/1.2.3.md
```

## Rules

**UI**
- The glass kit is the only visual language. Build with `packages/ui/src/kit` and its tokens; what
  it lacks is added to it, not drawn in place. Read the `glass-kit` skill before UI work.
- All UI lives in `packages/ui`, with relative imports. A host only supplies what it alone has.
- A change on desktop or web is a change on both. Adapt it to the other host in the same work, or
  say why it cannot apply. Read the `desktop-and-web` skill.

**Writing**
- English only in the product: UI, gateway messages, built-in skills, docs, fixtures. Examples use
  fictional names and tests use synthetic credentials.
- Release notes are written for people, through the `release-notes` skill, which runs `humanizer`.
- Comments say why a rule exists, what it guarantees, its units and its traps, not what the code
  says.

**Code**
- Change Zod schemas, never a generated file. Published migrations are immutable. Read the
  `contracts-and-migrations` skill.
- The agent is told only what it can do in that run: a tool, skill or reply never points at a tool
  the run does not have.
- Built-in skills are what the agent believes about Jian. A change to a tool, a screen or how Jian
  behaves updates the skill that describes it in the same work. Read the `built-in-skills` skill.
- Biome formats and lints: two spaces, single quotes, semicolons, 100 columns. Keep modules small.

**Tests and verification**
- Test authorization, isolation, persistence, concurrency, delivery and failures with external
  effects. No tests that mirror the implementation, count internal calls or chase coverage.
- Check what the change touches. Do not run `make check` for small changes or close the owner's
  running app to test; CI validates pushes, and the owner validates by hand.
- Report what did not run. Configuring CI is not running it, and a passing test does not show that
  a screen looks right.

**Git**
- Commit, push or release only when asked.
- No AI attribution anywhere: no `Co-Authored-By` trailer or "Generated with" line for any tool, in
  commits or pull requests.

## Traps

- A gateway route outside `/v1` needs a handler on both hosts (`apps/web`, and `FORWARDED` in
  `apps/desktop/src/main/protocol.ts`). The gateway does not serve the panel.
- The gateway has no hot reload: after changing it, restart it (**Restart local gateway** in the
  palette).
- `POSTGRES_PASSWORD` applies only when the volume is created. A recreated `.env` fails with
  `28P01`; `ALTER USER` fixes it without losing data.
- Unit tests need no Docker and no provider. Persistence tests need `TEST_DATABASE_URL`.
