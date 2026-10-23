import { randomUUID } from 'node:crypto';
import {
  activityQuerySchema,
  continuationSchema,
  type Message,
  type ModelSelection,
  type Run,
  runAnswerSchema,
  type Session,
  submitSchema,
  TASK_SESSION_CHANNEL,
} from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { resumePrompt } from '../agent/ask-user.js';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError, NoModelAvailable } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { bindMedia, mediaMarker } from '../media/repository.js';
import type { ProfileReader } from '../profiles/port.js';
import type { ModelFallback } from '../providers/fallback.js';
import type { ProviderSelection } from '../providers/port.js';
import { readModelDefaults, writeModelDefaults } from '../providers/repository.js';
import { parseObjectiveCommand } from '../sessions/objective.js';
import type { SessionReader } from '../sessions/port.js';
import { insertMessage, parseCavemanMode, parsePonytailMode } from '../sessions/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import { runs as runRows } from '../storage/schema.js';
import { queuesInbound } from './drain.js';
import type { SubmitOptions } from './port.js';
import {
  appendSteer,
  countActiveRuns,
  countRunsByDay,
  findActiveSessionRun,
  findRun,
  findRunByRequestKey,
  findWaitingSessionRun,
  insertRun,
  listActiveRuns,
  listRecentRuns,
  setRelayTo,
  updateRun,
} from './repository.js';
import { applySessionEffects, type PendingSessionEffects } from './session-effects.js';

/** The cap on what one profile may have waiting or in flight at once. */
const ACTIVE_RUN_LIMIT = 32;

const active = (run: Run) => run.status === 'running' || run.status === 'queued';

const cancellable = (run: Run) => active(run) || run.status === 'waiting';

type RunDeliveries = {
  deliverRun(profileId: string, sessionId: string, runId: string): Promise<void>;
};

export class Runs {
  private deliveries?: RunDeliveries;

  constructor(
    private readonly store: Store,
    private readonly profiles: ProfileReader,
    private readonly sessions: SessionReader,
    private readonly providers: ProviderSelection,
    private readonly clock: Clock = Date.now,
  ) {}

  /**
   * Set after construction because choosing a model needs the model discovery, which needs the
   * providers, which are built alongside this service. Absent in a gateway without discovery;
   * a run there needs a model the owner chose.
   */
  private fallback?: Pick<ModelFallback, 'pick'>;

  useFallback(fallback: Pick<ModelFallback, 'pick'>): void {
    this.fallback = fallback;
  }

  /** Channel sessions need a delivery hung on resume runs that did not arrive through ingress. */
  useDeliveries(deliveries: RunDeliveries): void {
    this.deliveries = deliveries;
  }

  /**
   * Whether this profile has a model for this activity that still runs. A default whose
   * provider was removed counts as none, or it would keep the automatic choice from ever
   * stepping in and every message would wait on a model that no longer exists.
   */
  private async configured(
    profileId: string,
    sessionId: string,
    activity: 'conversation' | 'channel',
  ): Promise<boolean> {
    const defaults = await readModelDefaults(this.store.db, profileId, nowIso(this.clock));
    const session = await this.sessions.session(profileId, sessionId).catch(() => undefined);
    const selection = session?.model ?? defaults[activity] ?? defaults.conversation;

    if (!selection) return false;

    return this.providers.selectedModel(selection, this.store.db).then(
      () => true,
      () => false,
    );
  }

  /**
   * A request key promises the same request. Different content under a key that is already
   * taken is a mistake on the caller's side, not a second run.
   */
  private sameRequest(run: Run, text: string, model?: ModelSelection): Run {
    if (
      run.input !== text ||
      (model && JSON.stringify(run.modelSelection) !== JSON.stringify(model))
    ) {
      throw new GatewayError(409, 'Request key was already used for different content');
    }

    return run;
  }

  /** Where a late answer goes when the agent that asked has already stopped waiting. */
  async relayTo(profileId: string, runId: string, sessionId: string | null) {
    await this.store.transaction(profileId, (tx) => setRelayTo(tx, runId, sessionId));
  }

  async submit(profileId: string, sessionId: string, input: unknown, options: SubmitOptions = {}) {
    const { continuationOf, activity = 'conversation', call, group, author, subagent } = options;
    const parsed = submitSchema.parse(input);
    const modeChange =
      options.ownerMessage && !parsed.mediaIds?.length ? parsePonytailMode(parsed.text) : undefined;
    const cavemanChange =
      options.ownerMessage && !parsed.mediaIds?.length ? parseCavemanMode(parsed.text) : undefined;
    // Panel owner messages and channel ingress both accept /objective commands.
    // Ordinary chat never auto-seeds — only these commands, the session API, or the agent tool.
    const fromPerson = Boolean(options.ownerMessage) || activity === 'channel';
    const objectiveCommand =
      fromPerson && !parsed.mediaIds?.length ? parseObjectiveCommand(parsed.text) : undefined;
    // Server handoffs carry results, never a fresh person command or blocked-goal reply.
    const effects: PendingSessionEffects = options.handoffToRunId
      ? { fromPerson: false }
      : { ponytail: modeChange, caveman: cavemanChange, objectiveCommand, fromPerson };
    const data = {
      ...parsed,
      text: [parsed.text, ...(parsed.mediaIds ?? []).map(mediaMarker)].filter(Boolean).join('\n'),
    };

    // Catalog refresh may use the network; never hold the profile transaction while it runs.
    if (!options.transaction) await this.providers.warmCatalog?.();

    // Choosing a model for an owner who has not can reach the provider, and the profile lock
    // must not be held across a network call — so it is resolved before the transaction and
    // used only if nothing is configured by the time the transaction reads it.
    const automatic =
      data.model || options.transaction || (await this.configured(profileId, sessionId, activity))
        ? null
        : await this.fallback?.pick().catch(() => null);

    const write = async (tx: Queryable) => {
      const profile = await this.profiles.profile(profileId, tx);

      if (continuationOf) {
        const parent = await this.run(profileId, continuationOf, tx);

        if (
          parent.sessionId !== sessionId ||
          !['interrupted', 'failed', 'cancelled'].includes(parent.status)
        ) {
          throw new GatewayError(409, 'Only stopped runs in this session can be continued');
        }
      }

      const session = await this.sessions.session(profileId, sessionId, tx);
      if (session.channel === TASK_SESSION_CHANNEL && !subagent) {
        throw new GatewayError(403, 'Subagent sessions cannot receive direct messages');
      }

      await bindMedia(tx, profileId, sessionId, data.mediaIds ?? []);

      const duplicate = await findRunByRequestKey(tx, profileId, sessionId, data.requestKey);

      if (duplicate) {
        return this.sameRequest(duplicate, data.text, data.model);
      }

      const draining = await queuesInbound(tx);
      const sessionEffects = async (runId: string, defer = draining) => {
        if (defer) {
          await tx
            .update(runRows)
            .set({ pendingSessionEffects: effects })
            .where(eq(runRows.id, runId));
        } else {
          await applySessionEffects(tx, profileId, sessionId, session, effects, this.clock);
        }
      };
      const waiting = await findWaitingSessionRun(tx, profileId, sessionId);

      // Answering a mid-run question resumes work; it is not a steer and not a bare "continue".
      if (waiting?.question) {
        const resumeKey = `ask-answer:${waiting.id}`;
        const answered = await findRunByRequestKey(tx, profileId, sessionId, resumeKey);
        if (answered) return this.sameRequest(answered, data.text, data.model);

        const resumed = await this.resumeWaiting(
          tx,
          profileId,
          session,
          waiting,
          data.text,
          resumeKey,
          data.mediaIds,
          author,
          activity,
        );
        await sessionEffects(resumed.id);
        return resumed;
      }

      let inFlight = draining ? null : await findActiveSessionRun(tx, profileId, sessionId);
      if (draining && options.handoffToRunId) {
        const caller = await this.run(profileId, options.handoffToRunId, tx);
        if (caller.sessionId !== sessionId) throw new GatewayError(409, 'Handoff session mismatch');
        // A completion may be needed by a caller still executing. Never steer queued ingress
        // instead, and never admit a new root merely because it is a completion notification.
        if (caller.status === 'running') inFlight = caller;
      }

      // A person who writes again while the agent is working is not starting a second turn —
      // they are changing what this one should be about. The message joins the run in flight
      // and is read between its steps, so nothing waits for a turn that already began.
      if (inFlight) {
        await bindMedia(tx, profileId, sessionId, data.mediaIds ?? [], inFlight.id);
        await insertMessage(tx, {
          id: randomUUID(),
          profileId,
          sessionId,
          runId: inFlight.id,
          role: 'user',
          content: data.text,
          ...(author ? { author } : {}),
          createdAt: nowIso(this.clock),
        });

        await sessionEffects(inFlight.id, false);

        await appendSteer(tx, inFlight.id, data.text);

        return inFlight;
      }

      const defaults = await readModelDefaults(tx, profileId, nowIso(this.clock));
      const candidates = data.model
        ? [data.model]
        : [session.model, defaults[activity] ?? defaults.conversation, automatic];
      let selection: ModelSelection | null = null;
      let chosen: Awaited<ReturnType<typeof this.providers.selectedModel>> | null = null;

      for (const candidate of candidates) {
        if (!candidate) continue;
        try {
          chosen = await this.providers.selectedModel(candidate, tx);
          selection = candidate;
          break;
        } catch (error) {
          if (data.model) throw error;
        }
      }
      // No list is invented here: which models a key can call is the provider's answer, so a
      // run needs either a model the owner chose or one picked from what a provider reports.
      if (!chosen && !profile.model.apiKeyEnv && !profile.model.providerId) {
        throw new NoModelAvailable();
      }

      // A model picked here becomes the profile's default, so the panel agrees with what just
      // ran and the next run does not have to choose again.
      if (chosen && selection && selection === automatic) {
        await writeModelDefaults(
          tx,
          profileId,
          { ...defaults, conversation: automatic },
          new Date(this.clock()),
        );
      }

      if ((await countActiveRuns(tx, profileId)) >= ACTIVE_RUN_LIMIT) {
        throw new GatewayError(429, 'Profile run limit reached');
      }

      // Freeze configuration for this run; later identity edits apply only to new runs. The
      // profile is stored as the version it is, and read back from that version's revision.
      const run: Run = {
        id: randomUUID(),
        profileId,
        sessionId,
        ...(subagent ? { subagent } : {}),
        requestKey: data.requestKey,
        input: data.text,
        profile,
        ...(chosen ? { model: chosen.config, contextPolicy: chosen.policy } : {}),
        ...(selection ? { modelSelection: selection } : {}),
        ...(call ? { call } : {}),
        ...(group ? { group } : {}),
        status: 'queued',
        ...(continuationOf ? { continuationOf } : {}),
        createdAt: nowIso(this.clock),
        updatedAt: nowIso(this.clock),
      };

      const collided = await insertRun(tx, run);

      if (collided) {
        return this.sameRequest(collided, data.text, data.model);
      }

      await bindMedia(tx, profileId, sessionId, data.mediaIds ?? [], run.id);

      // The message references the run, so it can only be written once the run exists.
      const message: Message = {
        id: randomUUID(),
        profileId,
        sessionId,
        runId: run.id,
        role: 'user',
        content: data.text,
        ...(author ? { author } : {}),
        createdAt: nowIso(this.clock),
      };

      await insertMessage(tx, message);
      await sessionEffects(run.id);

      await recordEvent(
        tx,
        this.clock,
        profileId,
        'run.queued',
        { sessionId, input: data.text },
        run.id,
      );

      return run;
    };
    return options.transaction
      ? write(options.transaction)
      : this.store.transaction(profileId, write);
  }

  async run(profileId: string, runId: string, reader: Queryable = this.store.db) {
    return assertFound(await findRun(reader, profileId, runId), 'Run');
  }

  /** What is in flight right now. The agent reads this to avoid repeating work under way. */
  async activities(profileId: string) {
    await this.profiles.profile(profileId);

    return listActiveRuns(this.store.db, profileId, 200);
  }

  /**
   * A year of days and how much this profile ran on each. Days with nothing are absent, and
   * the day is the reader's day: a calendar drawn in UTC puts a Brazilian evening on
   * tomorrow's square and tells them the wrong date about their own work.
   */
  async activity(profileId: string, zone?: string) {
    await this.profiles.profile(profileId);

    return countRunsByDay(this.store.db, profileId, 371, activityQuerySchema.parse({ zone }).zone);
  }

  /** What the profile has been doing, finished runs included, newest first. */
  async recent(profileId: string) {
    await this.profiles.profile(profileId);

    return listRecentRuns(this.store.db, profileId, 100);
  }

  async continueRun(profileId: string, runId: string, input: unknown) {
    const data = continuationSchema.parse(input);
    const parent = await this.run(profileId, runId);
    if (parent.subagent) throw new GatewayError(403, 'Subagents are managed by the agent');
    const text = `${data.text}\n\nContinuation of run ${runId}. Previously completed external effects must not be repeated. Operator reconciliation (data): ${JSON.stringify(data.reconciliation)}. Use read_run_checkpoints to inspect saved results before acting.`;

    // A continuation stays in the chain, and in the room, that started the run: both budgets
    // were already spent by the run being continued.
    return this.submit(
      profileId,
      parent.sessionId,
      { text, requestKey: data.requestKey },
      {
        continuationOf: runId,
        ...(parent.call ? { call: parent.call } : {}),
        ...(parent.group ? { group: parent.group } : {}),
      },
    );
  }

  /**
   * Explicit answer to a waiting run. Session submit also answers when a waiting run is open;
   * this path names the run so the panel can target it.
   */
  async answerRun(profileId: string, runId: string, input: unknown) {
    const data = runAnswerSchema.parse(input);
    const waiting = await this.run(profileId, runId);
    if (waiting.status !== 'waiting' || !waiting.question) {
      throw new GatewayError(409, 'That run is not waiting for an answer');
    }
    if (waiting.subagent) throw new GatewayError(403, 'Subagents are managed by the agent');

    const session = await this.sessions.session(profileId, waiting.sessionId);
    const resume = await this.store.transaction(profileId, async (tx) => {
      const requestKey = data.requestKey ?? `ask-answer:${waiting.id}`;
      const duplicate = await findRunByRequestKey(tx, profileId, waiting.sessionId, requestKey);
      if (duplicate) return this.sameRequest(duplicate, data.text);

      const fresh = await findRun(tx, profileId, runId);
      if (fresh?.status !== 'waiting' || !fresh.question) {
        throw new GatewayError(409, 'That run is not waiting for an answer');
      }

      return this.resumeWaiting(
        tx,
        profileId,
        session,
        fresh,
        data.text,
        requestKey,
        undefined,
        undefined,
        session.channel === 'gateway' || session.channel === 'learning'
          ? 'conversation'
          : 'channel',
      );
    });

    if (session.channel !== 'gateway' && session.channel !== 'learning') {
      await this.deliveries?.deliverRun(profileId, resume.sessionId, resume.id);
    }

    return resume;
  }

  async cancel(profileId: string, runId: string) {
    return this.store.transaction(profileId, async (tx) => {
      const run = await this.run(profileId, runId, tx);
      if (run.subagent) throw new GatewayError(403, 'Subagents are managed by the agent');

      if (!cancellable(run)) {
        return run;
      }

      const final: Run = {
        ...run,
        status: 'cancelled',
        updatedAt: nowIso(this.clock),
        leaseOwner: undefined,
        leaseUntil: undefined,
        question: undefined,
      };

      await updateRun(tx, final);
      await recordEvent(tx, this.clock, profileId, 'run.cancelled', {}, runId);

      return final;
    });
  }

  /**
   * Closes the waiting run and queues a resume turn whose input carries question + answer.
   * Must run inside the caller's profile transaction.
   */
  private async resumeWaiting(
    tx: Queryable,
    profileId: string,
    session: Session,
    waiting: Run,
    answer: string,
    requestKey: string,
    mediaIds: string[] | undefined,
    author: Message['author'] | undefined,
    activity: 'conversation' | 'channel',
  ): Promise<Run> {
    const question = waiting.question;
    if (!question) throw new GatewayError(409, 'That run is not waiting for an answer');

    const closed: Run = {
      ...waiting,
      status: 'completed',
      updatedAt: nowIso(this.clock),
      question: undefined,
      // Keep the question text as the parked run's output; delivery already sent it.
      output: waiting.output,
    };
    await updateRun(tx, closed);
    await recordEvent(tx, this.clock, profileId, 'run.answered', { answer }, waiting.id);

    await insertMessage(tx, {
      id: randomUUID(),
      profileId,
      sessionId: waiting.sessionId,
      runId: waiting.id,
      role: 'user',
      content: answer,
      ...(author ? { author } : {}),
      createdAt: nowIso(this.clock),
    });

    // Nested submit would open another transaction; build the resume run here instead.
    // Model fallback was resolved before the outer transaction when possible; here reuse the
    // waiting run's frozen model so the resume stays on the same choice.
    const profile = waiting.profile;
    const defaults = await readModelDefaults(tx, profileId, nowIso(this.clock));
    const candidates = [
      waiting.modelSelection,
      session.model,
      defaults[activity] ?? defaults.conversation,
    ];
    let selection: ModelSelection | null = null;
    let chosen: Awaited<ReturnType<typeof this.providers.selectedModel>> | null = null;

    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        chosen = await this.providers.selectedModel(candidate, tx);
        selection = candidate;
        break;
      } catch {
        // try next
      }
    }
    if (!chosen && waiting.model && waiting.contextPolicy) {
      chosen = { config: waiting.model, policy: waiting.contextPolicy };
      selection = waiting.modelSelection ?? null;
    }
    if (!chosen && !profile.model.apiKeyEnv && !profile.model.providerId) {
      throw new NoModelAvailable();
    }

    if ((await countActiveRuns(tx, profileId)) >= ACTIVE_RUN_LIMIT) {
      throw new GatewayError(429, 'Profile run limit reached');
    }

    const text = resumePrompt(question, answer);
    const run: Run = {
      id: randomUUID(),
      profileId,
      sessionId: waiting.sessionId,
      requestKey,
      input: text,
      profile,
      ...(chosen ? { model: chosen.config, contextPolicy: chosen.policy } : {}),
      ...(selection ? { modelSelection: selection } : {}),
      ...(waiting.call ? { call: waiting.call } : {}),
      ...(waiting.group ? { group: waiting.group } : {}),
      status: 'queued',
      continuationOf: waiting.id,
      createdAt: nowIso(this.clock),
      updatedAt: nowIso(this.clock),
    };

    const collided = await insertRun(tx, run);
    if (collided) return this.sameRequest(collided, text);

    await bindMedia(tx, profileId, waiting.sessionId, mediaIds ?? [], run.id);

    await insertMessage(tx, {
      id: randomUUID(),
      profileId,
      sessionId: waiting.sessionId,
      runId: run.id,
      role: 'user',
      content: text,
      createdAt: nowIso(this.clock),
    });

    await recordEvent(
      tx,
      this.clock,
      profileId,
      'run.queued',
      { sessionId: waiting.sessionId, input: text, resumedFrom: waiting.id },
      run.id,
    );

    return run;
  }
}
