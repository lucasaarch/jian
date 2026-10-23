# Predeploy execution drain

This optional, internal one-shot hook closes admission before a controlled gateway
replacement. **It is not enabled in production by this change.** No Cubeship app, API,
hook configuration or environment is changed by shipping these commands.

The protocol is **fail-closed**, not bounded automatic recovery: once requested, a
persistent gate remains active through success, timeout, SIGINT/SIGTERM, SIGKILL, database
failure and failed replacement. It never expires open. Starting a replacement worker does
not release it. Plan for an operator-managed admission outage until explicit recovery.

## Bootstrap before enabling any hook

1. Back up the database. Apply migration `0060_deployment-drain` and deploy the admission
   fence to **every process that can claim an execution**, including all API/worker roles,
   without enabling the hook. The first upgrade is not protected by the new protocol; use a
   maintenance window if existing executions must not be interrupted.
2. Confirm that all claimers run compatible drain-aware code and that the migration,
   including `deployment_drain_generations` and the execution-marker columns, has applied.
   An older worker ignores the fence. Shipping the CLI only in the incoming image cannot
   protect a mixed installation.
3. Rehearse normal replacement, timeout, killed hook, failed stop/swap, orphan reconciliation
   and explicit release in staging. Establish who can cancel/stop deployments and positively
   verify executor shutdown before enabling the hook for later compatible deployments.

Neither CLI migrates the database or starts HTTP, workers, channels, providers or queues.
Missing schema fails rather than bootstrapping an unprotected deployment. Incoming schema
changes must remain compatible with the old image while it is still running; the drain
cannot make destructive migrations safe.

## Hook command and generation identity

The ordinary server build includes both CLIs. In the published image (`WORKDIR /app`):

```sh
node dist/predeploy-drain.js --timeout-seconds 480
```

A generation is mandatory: the command reads `CUBESHIP_DEPLOYMENT_ID`, or takes an explicit
`--generation ID` (which overrides that environment value). On a platform without that
variable, use a unique deployment identifier explicitly:

```sh
node dist/predeploy-drain.js --timeout-seconds 480 --generation deploy-2026-10-23-001
```

From a checkout after building the contracts and gateway server, the entrypoint is
`apps/gateway/dist/predeploy-drain.js`. Both commands require `DATABASE_URL`; locally, load
an env file explicitly with Node's `--env-file` if needed. Do not print credentials in logs.
`JIAN_ROLE` does not narrow the database-wide fence.

Only these hook flags are accepted:

- `--timeout-seconds N`: optional, raw integer seconds from **1 through 3600**, default 480.
  Fractions, nonfinite values and unit suffixes are rejected.
- `--generation ID`: optional only when `CUBESHIP_DEPLOYMENT_ID` supplies a valid ID. IDs are
  1–200 characters from letters, digits, `_`, `.`, `:`, and `-`.

Unknown, repeated or incomplete flags fail. **`--hold-seconds` is rejected**: there is no
hold-duration option and no finite admission-release timer.

Retries of the **same active generation** are idempotent, including when it is already
holding. A different generation cannot take over an active gate. Every requested ID is
recorded in the persistent `deployment_drain_generations` table; after release, that ID is
consumed and cannot start another drain. Never delete generation history to retry a deploy.

The hook exits zero only after observing zero relevant executions/dependencies and committing
`holding` under the claim fence. Timeout, handled cancellation or failure exits nonzero;
there is no error-handler release. Connection, statement and lock waits are bounded to five
seconds, with a hard watchdog at the requested timeout plus 15 seconds. These bounds limit
**the command**, not the lifetime of its persistent gate. An uncertain database outcome must
be inspected: a request might have committed even if the hook reports failure.

## Admission and zero-check protocol

A singleton `deployment_drain` row stores the active generation in `owner` and a phase.
Its row lock serializes admission, zero checks and phase changes. Activity is determined by
an owner being present, **not by `expires_at`**.

1. **Draining:** new owner ingress is persisted as queued runs instead of steering an
   execution already finishing. Queued payloads are excluded from automatic context and
   model-facing history reads; activity tools expose only their queue metadata. Owner/UI
   history remains available. Queued session commands (objective and response modes) take
   effect only when that run is admitted, not while an earlier executor is finishing.
   Existing executions are not cancelled. Normal validation and run/profile caps still
   apply; this is not an unlimited ingress buffer.
2. Internal peer-call and subagent dependencies (`call`/`subagent` metadata) remain claimable
   during draining, including already-queued dependencies and those submitted after the
   request. Dispatch selects these before pagination, so blocked roots cannot hide them.
   The zero check includes queued dependencies even after their original parent/root has
   ended. Waiting-answer runs with request keys starting `ask-answer:` are **new owner
   ingress**, not drain dependencies, even if they retain peer-addressing metadata.
3. Worker reports and late peer answers can still reach their exact, still-running caller
   through the server-only handoff so it can finish; they do not consume queued owner
   ingress. If that caller has ended, completion persists as a queued root turn. Objective
   slices and ordinary continuations also persist queued rather than being dropped. The
   drain waits for executions and queued internal dependencies, not all objectives, queued
   roots, future user answers or the entire autonomous task graph.
4. **Holding:** zero requires no running run, no execution-owner marker, and no queued
   internal dependency (excluding `ask-answer:`). The zero check and holding transition use
   the same fence as the queued-to-running claim and marker write: there is no unlocked
   zero-check/claim gap. Every claim is then rejected, including old and new workers,
   dependencies and already-dispatched pg-boss jobs. Rejected jobs leave runs queued for
   rediscovery after explicit release.

An execution-owner marker covers `AgentRuntime.execute()` through handoffs and final
cleanup. Marking a run terminal is not proof that its executor finished: the current runtime
retains ownership through cleanup and only then releases its exact owner's marker. MCP stdio
transports are owned before initialization returns, and cleanup waits for observed child closure;
failed initialization/listing/reconnection must not discard an acquired cleanup handle. A
same-session successor is excluded while a predecessor is running **or still has an execution
marker**. Profile reset and deletion protect these markers rather than erasing evidence.

The gate's `expires_at` and the executor's `execution_until` are **diagnostic timestamps
only**. Neither age, missing heartbeats nor ordinary run-lease expiry proves an executor is
gone. An expired execution marker still blocks zero and same-session successors until its
owner cleans up or an operator explicitly reconciles it. Stale owners cannot clear another
owner's marker. No worker startup or post-swap status poll automatically releases the gate.

## Operator recovery: inspect, stop, reconcile, release

These operator-only commands are not HTTP/model tools. They require the same database and
compatible schema. Examples below use image paths; prefix `apps/gateway/` in a checkout.

### 1. Inspect without changing state

```sh
node dist/predeploy-recover.js
# Equivalent explicit action:
node dist/predeploy-recover.js inspect
```

Inspection is read-only and safe to repeat. It reports the singleton gate and execution-owner
markers, including run/profile IDs, status, owner and diagnostic expiry. These are diagnostic
snapshots, not a transactionally complete proof of quiescence or a platform swap
acknowledgement. An empty marker list is not authorization to release a pending deployment.

### 2. Resolve the platform operation out of band

Before release, **cancel or fully finish every pending deployment/swap**, prevent delayed
hooks or replacements from subsequently acting, and positively verify that all old executors
have stopped. Use platform/process controls and independent evidence. Merely requesting a
cancel/stop, seeing a timeout or a deployment status, or starting a new worker is insufficient.
If the pending operation or executor state is uncertain, keep admission closed.

This also applies after a nonzero hook exit or SIGKILL. Do not let the platform proceed after
failure, and do not assume that failure removed a previously committed gate. A same-generation
hook retry can continue draining while that generation remains active; it is not a release.

### 3. Reconcile only positively stopped orphan executors

Allow normal live owners to finish cleanup. If an executor died leaving a marker, first
positively stop/verify **that exact executor**, inspect possible external effects, and use the
active generation and exact identifiers from inspection:

```sh
node dist/predeploy-recover.js reconcile --generation ID --run-id UUID --execution-owner OWNER --confirm-executor-stopped
```

Reconciliation requires the explicit stopped-executor assertion and matches the active
generation, run UUID and execution owner. It clears that marker, marks a still-running run
`interrupted`, and records `run.execution-reconciled` with the prior status, owner, generation
and operator assertion. Terminal status is otherwise preserved. It preserves audit evidence;
it does **not** replay the run, resolve uncertain effects or prove that a remote process died.
An expired timestamp alone is never grounds for this assertion. Never use direct SQL, profile
reset or deletion as a substitute for reconciliation.

### 4. Release the exact generation explicitly

Only after the platform operation is resolved and all old executors are verified stopped:

```sh
node dist/predeploy-recover.js release --generation ID --confirm-deployment-stopped
```

The assertion is an operator responsibility, not a platform check performed by this CLI.
Release is generation-matched; a stale/mismatched release fails instead of clearing a newer
gate. It clears admission and records release in generation history without deleting that
history or replaying work. Persisted queued runs and continuations can resume through normal
dispatch and session serialization. Release is not a substitute for reconciling or investigating
orphan markers: it does not clear them. Inspect again after any uncertain recovery result.

There is **no automatic post-swap release**, including on successful replacement. Do not add
a status-poll release loop or treat a new worker's health check as stop confirmation.

## Deployment contract and limits

Use this only for a **single controlled deployment with operator-reconciled recovery**:

- Bootstrap every claimer and the migration first; serialize deployments.
- Run the new image's one-shot hook with the same database/network while the old service can
  finish executions. Wait for success before starting/swapping the replacement. Never mask
  a nonzero exit with `|| true` or a shell pipeline.
- Keep the CLI deadline below the platform hook deadline, with watchdog/connection-close
  margin. No timeout value opens the gate.
- Arrange out-of-band cancellation/stop verification and explicit release for both success
  and failure. Keep recovery access available even while worker admission is closed.

The shared-database admission fence is **not generic multinode or remote-deployment
fencing**. It does not stop a host/container, prevent an unrelated deployment controller from
acting, or protect against old/unsupported claimers. In particular, it does **not guarantee
volume safety when Cubeship logs a stop failure and continues deployment**: a successful hook
or status response cannot establish that the old volume user/container is gone. Verify actual
stop/cancel out of band; if the platform cannot provide the required control, do not treat
this hook as making that deployment safe.

The protocol does not fence detached processes, remote executors or external tool effects;
stop/reconcile assertions cannot undo uncertain effects or provide exactly-once execution.
It also does not establish total background-service quiescence: HTTP requests, channel
connections/delivery, schedules, subscriptions and unrelated services are outside this drain.
It cannot guarantee capacity for arbitrary dependency graphs or make incompatible migrations
safe. A blocked dependency or orphan marker can intentionally keep admission closed indefinitely.

## Rollbacks

A drain-aware, schema-compatible rollback can use a fresh generation and the same protocol,
including manual post-swap release. Keep the additive tables/columns and consumed-generation
history. Before rolling back to a version without the fence/CLIs, disable the hook and arrange
a separate maintenance-window stop/drain; that target is not protected by this protocol.
Database restore and schema rollback remain separate operational procedures.

## Regression checks to run

These are commands to run, **not a claim that they have passed**. Use disposable databases,
never production or the gateway's own database. Do not run the PostgreSQL suites concurrently
against the same database: the singleton gate intentionally spans all profiles.

```sh
pnpm --filter @jian/contracts build
# Normal suite (PGlite); the optional PostgreSQL drain suite skips without its env variable:
pnpm --filter @jian/gateway test
# Targeted normal regression check:
pnpm --filter @jian/gateway exec vitest run tests/drain.test.ts tests/cleanup-ownership.test.ts

# Opt-in, independent-connection PostgreSQL races, using a fresh disposable database:
DRAIN_TEST_DATABASE_URL=postgresql://... pnpm --filter @jian/gateway exec vitest run tests/drain-postgres.test.ts
# Separate fresh disposable database: real CLI process/signal and pg-boss integration:
TEST_DATABASE_URL=postgresql://... pnpm --filter @jian/gateway test:integration

pnpm --filter @jian/gateway build:server
pnpm --filter @jian/gateway typecheck
pnpm lint
```

The PostgreSQL integration tests exercise real CLI timeout/SIGTERM/SIGKILL/success and
persisted fencing, plus an already-dispatched pg-boss job rediscovered after explicit release.
The opt-in suite covers independent connections, queued dependencies, aged markers,
same-session exclusion and reset/delete protection. `test:integration` builds the server first
and launches the compiled `dist/` CLI; it is not itself proof of the packed artifact.

Also smoke-test the packed server CLIs before deployment. For a checkout with installed
workspace dependencies, this stages the gateway package inside that checkout so the unpacked
CLIs resolve the existing dependencies (it is not a standalone-package install test):

```sh
# Run from the repository root, after the contracts/server builds above.
# All files below are staging artifacts; use a new directory for each check.
STAGE=$(mktemp -d "$PWD/apps/gateway/.drain-smoke.XXXXXX")
pnpm --filter @jian/gateway pack --out "$STAGE/gateway.tgz"
tar -xzf "$STAGE/gateway.tgz" -C "$STAGE"
# Fresh disposable, migrated database only; inspection does not migrate it.
DATABASE_URL=postgresql://... node "$STAGE/package/dist/predeploy-recover.js" inspect
DATABASE_URL=postgresql://... node "$STAGE/package/dist/predeploy-drain.js" --timeout-seconds 1 --generation packed-smoke-unique-ID
DATABASE_URL=postgresql://... node "$STAGE/package/dist/predeploy-recover.js" inspect
# In this isolated smoke test only, after verifying no pending deployment or old executor:
DATABASE_URL=postgresql://... node "$STAGE/package/dist/predeploy-recover.js" release --generation packed-smoke-unique-ID --confirm-deployment-stopped
```

Verify that the smoke hook holds until release, a consumed ID fails on retry, invalid flags
(including `--hold-seconds`) fail, and logs do not expose credentials. Record actual command
results separately. Repeat with the published image's `dist/` entrypoints in staging to verify
its packaged runtime dependencies and platform lifecycle; never infer those guarantees just
from a source test or successful package extraction.
