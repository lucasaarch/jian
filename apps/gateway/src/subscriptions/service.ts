import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type Run,
  SUBSCRIPTION_DEFAULT_TTL_SECONDS,
  SUBSCRIPTION_LIMIT,
  type Subscription,
  subscriptionInputSchema,
  subscriptionPatchSchema,
} from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { ProfileReader } from '../profiles/port.js';
import type { Vault } from '../security/vault.js';
import { objectiveAt } from '../sessions/objective.js';
import type { SessionReader } from '../sessions/port.js';
import { setSessionObjective } from '../sessions/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import {
  detectPollWake,
  type GithubTokenSource,
  observationsEqual,
  observationToStore,
  observeGithub,
  pollIntervalMs,
} from './github-poll.js';
import {
  deleteSubscription,
  dueSubscriptions,
  findDeliveryByKey,
  findSubscription,
  findSubscriptionById,
  insertDelivery,
  insertSubscription,
  listDeliveries,
  listSubscriptions,
  replaceSubscription,
  toSubscription,
} from './repository.js';

function expiresAtFromDuration(clock: Clock, durationSeconds: number | undefined): string {
  const seconds = durationSeconds ?? SUBSCRIPTION_DEFAULT_TTL_SECONDS;
  return new Date(clock() + seconds * 1_000).toISOString();
}

function isExpired(subscription: Pick<Subscription, 'expiresAt'>, now: Date): boolean {
  return Date.parse(subscription.expiresAt) <= now.getTime();
}

type RunSubmitter = {
  submit(
    profileId: string,
    sessionId: string,
    input: unknown,
    options?: { transaction?: Queryable },
  ): Promise<Run>;
};

type Deliveries = {
  deliverRun(profileId: string, sessionId: string, runId: string): Promise<void>;
};

export const subscriptionSecret = (id: string) => `subscription:${id}`;

function hashSecret(secret: string): string {
  return createHmac('sha256', 'jian-subscription-webhook').update(secret).digest('hex');
}

function verifyGithubSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const actual = header.slice('sha256='.length);
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
  } catch {
    return false;
  }
}

function githubEventName(
  event: string | undefined,
  payload: Record<string, unknown>,
): string | undefined {
  if (!event) return undefined;
  if (event === 'check_suite' && payload.action === 'completed') return 'check_suite.completed';
  if (event === 'pull_request' && payload.action === 'closed') return 'pull_request.closed';
  return undefined;
}

function githubRepo(payload: Record<string, unknown>): { owner: string; repo: string } | undefined {
  const repository = payload.repository as
    | { name?: string; owner?: { login?: string } }
    | undefined;
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

export class Subscriptions {
  private wakeDelivery?: Deliveries;
  private fetcher: typeof fetch;
  private tokens?: GithubTokenSource;

  constructor(
    private readonly store: Store,
    private readonly profiles: ProfileReader,
    private readonly sessions: SessionReader,
    private readonly runs: RunSubmitter,
    private readonly vault: Vault,
    private readonly clock: Clock = Date.now,
    fetcher: typeof fetch = fetch,
    tokens?: GithubTokenSource,
  ) {
    this.fetcher = fetcher;
    this.tokens = tokens;
  }

  useDeliveries(channel: Deliveries) {
    this.wakeDelivery = channel;
  }

  useGithub(fetcher: typeof fetch, tokens?: GithubTokenSource) {
    this.fetcher = fetcher;
    this.tokens = tokens;
  }

  async list(profileId: string) {
    await this.profiles.profile(profileId);
    return listSubscriptions(this.store.db, profileId);
  }

  async create(profileId: string, input: unknown, createdBy: Subscription['createdBy']) {
    const data = subscriptionInputSchema.parse(input);
    const secret = randomBytes(32).toString('hex');

    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      await this.sessions.session(profileId, data.sessionId, tx);

      if ((await listSubscriptions(tx, profileId)).length >= SUBSCRIPTION_LIMIT) {
        throw new GatewayError(409, `A profile keeps at most ${SUBSCRIPTION_LIMIT} subscriptions`);
      }

      const now = nowIso(this.clock);
      const subscription: Subscription = {
        id: randomUUID(),
        profileId,
        name: data.name,
        instruction: data.instruction,
        sessionId: data.sessionId,
        source: data.source,
        filter: data.filter,
        enabled: data.enabled,
        createdBy,
        // Poll immediately so a brand-new watcher does not wait a full interval.
        ...(data.enabled ? { nextPollAt: now } : {}),
        expiresAt: expiresAtFromDuration(this.clock, data.durationSeconds),
        createdAt: now,
        updatedAt: now,
      };

      await insertSubscription(tx, subscription, hashSecret(secret));
      await this.vault.put(profileId, subscriptionSecret(subscription.id), secret, tx);
      await recordEvent(tx, this.clock, profileId, 'subscription.created', {
        id: subscription.id,
      });

      // Pause objective auto-continue while this listener waits — otherwise every empty
      // poll interval the model restates "still pending" on the channel.
      if (data.enabled) {
        await this.pauseObjectiveForListening(tx, profileId, data.sessionId, data.name);
      }

      // Webhook secret is optional acceleration; polling is the default path.
      return { ...subscription, webhookSecret: secret };
    });
  }

  async update(profileId: string, id: string, input: unknown) {
    const data = subscriptionPatchSchema.parse(input);

    return this.store.transaction(profileId, async (tx) => {
      const current = assertFound(await findSubscription(tx, profileId, id), 'Subscription');
      if (data.sessionId) await this.sessions.session(profileId, data.sessionId, tx);

      const row = await findSubscriptionById(tx, id);
      if (!row) throw new GatewayError(404, 'Subscription not found');

      const enabled = data.enabled ?? current.enabled;
      const { nextPollAt: previousPoll, ...kept } = current;
      const now = new Date(this.clock());
      // Re-enable or an explicit duration resets the TTL; otherwise keep the existing deadline.
      const renewTtl =
        data.durationSeconds !== undefined || (data.enabled === true && isExpired(current, now));
      const next: Subscription = {
        ...kept,
        ...(data.name ? { name: data.name } : {}),
        ...(data.instruction ? { instruction: data.instruction } : {}),
        ...(data.sessionId ? { sessionId: data.sessionId } : {}),
        filter: data.filter ?? current.filter,
        enabled,
        ...(renewTtl ? { expiresAt: expiresAtFromDuration(this.clock, data.durationSeconds) } : {}),
        ...(enabled
          ? {
              // Re-enable or first poll schedule: check soon. Otherwise keep the existing cadence.
              nextPollAt:
                data.enabled === true || !previousPoll ? nowIso(this.clock) : previousPoll,
            }
          : {}),
        updatedAt: nowIso(this.clock),
      };
      await replaceSubscription(tx, next, row.secretHash);
      // Re-enable only — a filter tweak mid-wait must not re-block an objective already resumed.
      if (data.enabled === true) {
        await this.pauseObjectiveForListening(tx, profileId, next.sessionId, next.name);
      }
      return next;
    });
  }

  async remove(profileId: string, id: string) {
    return this.store.transaction(profileId, async (tx) => {
      const current = assertFound(await findSubscription(tx, profileId, id), 'Subscription');
      await deleteSubscription(tx, profileId, id);
      await this.vault.discard(profileId, subscriptionSecret(id), tx);
      await recordEvent(tx, this.clock, profileId, 'subscription.deleted', { id });
      return current;
    });
  }

  async history(profileId: string, id: string) {
    await assertFound(await findSubscription(this.store.db, profileId, id), 'Subscription');
    return listDeliveries(this.store.db, profileId, id);
  }

  private pauseObjectiveForListening(
    tx: Queryable,
    profileId: string,
    sessionId: string,
    listenerName: string,
  ) {
    return pauseObjectiveForListeningImpl(
      this.sessions,
      tx,
      this.clock,
      profileId,
      sessionId,
      listenerName,
    );
  }

  private resumeObjectiveForListening(tx: Queryable, profileId: string, sessionId: string) {
    return resumeObjectiveForListeningImpl(this.sessions, tx, this.clock, profileId, sessionId);
  }

  /**
   * Polls every due subscription against GitHub. Wakes only when the watched snapshot changes
   * in a meaningful way (CI conclusion, PR merge/close). Unchanged polls advance nextPollAt
   * only — no run submit, no channel delivery. Expired listeners switch off silently.
   */
  async pollDue() {
    const now = new Date(this.clock());

    for (const subscription of await dueSubscriptions(this.store.db, now)) {
      const row = await findSubscriptionById(this.store.db, subscription.id);
      if (!row?.enabled) continue;

      if (isExpired(subscription, now)) {
        const { nextPollAt: _drop, ...kept } = subscription;
        await this.store.transaction(subscription.profileId, async (tx) => {
          await replaceSubscription(
            tx,
            {
              ...kept,
              enabled: false,
              lastError: 'Listening expired.',
              updatedAt: nowIso(this.clock),
            },
            row.secretHash,
          );
          await recordEvent(tx, this.clock, subscription.profileId, 'subscription.expired', {
            id: subscription.id,
          });
        });
        continue;
      }

      const token = await this.tokens?.tokenFor(subscription.profileId);
      const { observation, error } = await observeGithub(subscription.filter, this.fetcher, token);
      const nextPollAt = new Date(
        now.getTime() + pollIntervalMs(subscription.filter),
      ).toISOString();

      if (error && !subscription.filter.pullNumber) {
        await replaceSubscription(
          this.store.db,
          {
            ...subscription,
            nextPollAt,
            lastError: error.slice(0, 2000),
            updatedAt: nowIso(this.clock),
          },
          row.secretHash,
        );
        continue;
      }

      // On fetch error keep the prior snapshot — an empty {} must not unlock another wake.
      const snapshot = error
        ? observationToStore(subscription.lastObservation, {
            ...subscription.lastObservation,
            ...observation,
          })
        : observationToStore(subscription.lastObservation, observation);
      const unchanged = observationsEqual(subscription.lastObservation, snapshot);
      const wake = error || unchanged ? undefined : detectPollWake(subscription, snapshot);

      if (!wake) {
        await replaceSubscription(
          this.store.db,
          {
            ...subscription,
            nextPollAt,
            // Persist the stabilized snapshot so a brief empty check-runs response cannot erase
            // a completion we already recorded for this head.
            lastObservation: snapshot,
            ...(error ? { lastError: error.slice(0, 2000) } : { lastError: undefined }),
            updatedAt: nowIso(this.clock),
          },
          row.secretHash,
        );
        continue;
      }

      await this.wakeFromPoll(subscription, row.secretHash, wake, nextPollAt, snapshot, error);
    }
  }

  private async wakeFromPoll(
    subscription: Subscription,
    secretHash: string,
    wake: NonNullable<ReturnType<typeof detectPollWake>>,
    nextPollAt: string,
    observation: Subscription['lastObservation'],
    observeError: string | undefined,
  ) {
    const existing = await findDeliveryByKey(this.store.db, subscription.id, wake.deliveryKey);
    if (existing?.runId) {
      await replaceSubscription(
        this.store.db,
        {
          ...subscription,
          nextPollAt,
          lastObservation: wake.observation,
          lastError: undefined,
          updatedAt: nowIso(this.clock),
        },
        secretHash,
      );
      return;
    }

    const text = [
      subscription.instruction,
      '',
      `GitHub event: ${wake.event}`,
      `Repository: ${subscription.filter.owner}/${subscription.filter.repo}`,
      ...wake.summary,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const run = await this.store.transaction(subscription.profileId, async (tx) => {
        // A real state change resumes work the create path paused.
        await this.resumeObjectiveForListening(tx, subscription.profileId, subscription.sessionId);

        const submitted = await this.runs.submit(
          subscription.profileId,
          subscription.sessionId,
          {
            text,
            requestKey: `subscription:${subscription.id}:${wake.deliveryKey}`,
          },
          { transaction: tx },
        );

        await insertDelivery(tx, {
          id: randomUUID(),
          subscriptionId: subscription.id,
          profileId: subscription.profileId,
          deliveryKey: wake.deliveryKey,
          event: wake.event,
          runId: submitted.id,
          createdAt: nowIso(this.clock),
        });
        await replaceSubscription(
          tx,
          {
            ...subscription,
            nextPollAt,
            lastObservation: wake.observation,
            lastWakeAt: nowIso(this.clock),
            lastRunId: submitted.id,
            lastError: undefined,
            updatedAt: nowIso(this.clock),
          },
          secretHash,
        );
        return submitted;
      });

      await this.wakeDelivery?.deliverRun(subscription.profileId, subscription.sessionId, run.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Wake failed';
      await replaceSubscription(
        this.store.db,
        {
          ...subscription,
          nextPollAt,
          lastObservation: observation,
          lastError: (observeError ?? message).slice(0, 2000),
          updatedAt: nowIso(this.clock),
        },
        secretHash,
      );
    }
  }

  /** GitHub webhook ingress: HMAC verify, match filter, wake the session once per delivery. */
  async receiveGithub(
    subscriptionId: string,
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
    payload: Record<string, unknown>,
  ): Promise<{ accepted: boolean; runId?: string }> {
    const row = await findSubscriptionById(this.store.db, subscriptionId);
    if (!row) return { accepted: false };
    if (!row.enabled) return { accepted: false };
    if (isExpired(toSubscription(row), new Date(this.clock()))) return { accepted: false };

    const secret = await this.vault.read(row.profileId, subscriptionSecret(subscriptionId));
    if (!secret) throw new GatewayError(401, 'Webhook secret is missing');
    const signature = header(headers, 'x-hub-signature-256');
    if (!verifyGithubSignature(secret, rawBody, signature)) {
      throw new GatewayError(401, 'Invalid GitHub webhook signature');
    }

    const eventHeader = header(headers, 'x-github-event');
    const event = githubEventName(eventHeader, payload);
    const repo = githubRepo(payload);
    if (!event || !repo) return { accepted: false };

    const subscription = toSubscription(row);
    if (
      subscription.filter.owner !== repo.owner ||
      subscription.filter.repo !== repo.repo ||
      !subscription.filter.events.includes(event as (typeof subscription.filter.events)[number])
    ) {
      return { accepted: false };
    }

    const deliveryId = header(headers, 'x-github-delivery') ?? `${event}:${rawBody.length}`;
    const existing = await findDeliveryByKey(this.store.db, subscriptionId, deliveryId);
    if (existing?.runId) return { accepted: true, runId: existing.runId };

    const text = [
      subscription.instruction,
      '',
      `GitHub event: ${event}`,
      `Repository: ${repo.owner}/${repo.repo}`,
      payload.pull_request && typeof payload.pull_request === 'object'
        ? `Pull request: #${(payload.pull_request as { number?: number }).number ?? '?'}`
        : '',
      payload.check_suite && typeof payload.check_suite === 'object'
        ? `Check suite conclusion: ${(payload.check_suite as { conclusion?: string }).conclusion ?? '?'}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const run = await this.store.transaction(subscription.profileId, async (tx) => {
        await this.resumeObjectiveForListening(tx, subscription.profileId, subscription.sessionId);

        const submitted = await this.runs.submit(
          subscription.profileId,
          subscription.sessionId,
          {
            text,
            requestKey: `subscription:${subscriptionId}:${deliveryId}`,
          },
          { transaction: tx },
        );

        await insertDelivery(tx, {
          id: randomUUID(),
          subscriptionId,
          profileId: subscription.profileId,
          deliveryKey: deliveryId,
          event,
          runId: submitted.id,
          createdAt: nowIso(this.clock),
        });
        await replaceSubscription(
          tx,
          {
            ...subscription,
            lastWakeAt: nowIso(this.clock),
            lastRunId: submitted.id,
            lastError: undefined,
            updatedAt: nowIso(this.clock),
          },
          row.secretHash,
        );
        return submitted;
      });

      await this.wakeDelivery?.deliverRun(subscription.profileId, subscription.sessionId, run.id);
      return { accepted: true, runId: run.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Wake failed';
      await this.store.transaction(subscription.profileId, async (tx) => {
        await insertDelivery(tx, {
          id: randomUUID(),
          subscriptionId,
          profileId: subscription.profileId,
          deliveryKey: deliveryId,
          event,
          error: message.slice(0, 2000),
          createdAt: nowIso(this.clock),
        }).catch(() => undefined);
        await replaceSubscription(
          tx,
          {
            ...subscription,
            lastError: message.slice(0, 2000),
            updatedAt: nowIso(this.clock),
          },
          row.secretHash,
        );
      });
      throw error;
    }
  }
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Pause open-objective auto-continue while a listener waits for a GitHub transition. */
async function pauseObjectiveForListeningImpl(
  sessions: SessionReader,
  tx: Queryable,
  clock: Clock,
  profileId: string,
  sessionId: string,
  listenerName: string,
) {
  const session = await sessions.session(profileId, sessionId, tx);
  const objective = session.objective;
  if (objective?.status !== 'open' || !objective.text) return;

  await setSessionObjective(
    tx,
    profileId,
    sessionId,
    objectiveAt(objective.text, 'blocked', nowIso(clock), {
      continuations: objective.continuations,
      note: `Waiting for Listening (${listenerName}). The gateway wakes this conversation when the watched state changes.`,
    }),
  );
}

/** Resume an objective the Listening path paused — leave owner-blocked questions alone. */
async function resumeObjectiveForListeningImpl(
  sessions: SessionReader,
  tx: Queryable,
  clock: Clock,
  profileId: string,
  sessionId: string,
) {
  const session = await sessions.session(profileId, sessionId, tx);
  const objective = session.objective;
  if (objective?.status !== 'blocked' || !objective.text) return;
  if (objective.note && !/Listening/i.test(objective.note)) return;

  await setSessionObjective(
    tx,
    profileId,
    sessionId,
    objectiveAt(objective.text, 'open', nowIso(clock), {
      continuations: 0,
    }),
  );
}
