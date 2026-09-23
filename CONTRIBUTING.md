# Contributing to Jian

Use Node.js 24+ and the pnpm version pinned in the repository. Install with
`pnpm install --frozen-lockfile` and run `pnpm check` before opening a change.

## Where code goes

- Products live in `apps`, shared libraries in `packages`.
- HTTP contracts live in `packages/contracts`. Change the Zod schemas, then run
  `pnpm contracts:generate`.
- Generated files have their own drift check. Never edit one by hand.
- Published migrations are immutable. A later change gets a new version.

## Style

Biome enforces two spaces, single quotes, semicolons and 100 columns. Husky and
lint-staged check staged files before each commit.

Prefer descriptive names, one responsibility per function, and named functions over deeply
nested expressions. Separate validation, reads, decisions, effects and the return value
into visible blocks.

Comments explain why a rule exists and what it guarantees — decisions, units, trust
boundaries and traps. They do not narrate obvious operations.

## Tests

Cover the behaviour that matters: authorization, isolation, persistence, concurrency,
delivery, and failures with external effects. Do not write tests that mirror the
implementation, count internal calls, inflate coverage or check formatting alone. A
behaviour-preserving refactor should reuse the tests that already exist.

Use synthetic credentials in tests and examples, never real ones.

Unit tests need neither Docker nor a provider. Persistence tests need a disposable
PostgreSQL and `TEST_DATABASE_URL`; CI provisions that environment.

## Workflow

Implement the change directly. We do not require spec-driven development, approval
documents or TDD. The OpenAPI contract describes a running API; it is not a planning step.

When you describe a change, say which of these you actually did: local tests, integration
tests, CI, or validation against an external service. Do not report verification that did
not happen.
