import { randomUUID } from 'node:crypto';
import {
  activityQuerySchema,
  continuationSchema,
  type Message,
  type ModelSelection,
  type Run,
  submitSchema,
} from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { bindMedia, mediaMarker } from '../media/repository.js';
import type { ProfileReader } from '../profiles/port.js';
import type { ModelFallback } from '../providers/fallback.js';
import type { ProviderSelection } from '../providers/port.js';
import { readModelDefaults, writeModelDefaults } from '../providers/repository.js';
import type { SessionReader } from '../sessions/port.js';
import { insertMessage } from '../sessions/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import type { SubmitOptions } from './port.js';
import {
  appendSteer,
  countActiveRuns,
  countRunsByDay,
  findActiveSessionRun,
  findRun,
  findRunByRequestKey,
  insertRun,
  listActiveRuns,
  listRecentRuns,
  setRelayTo,
  updateRun,
} from './repository.js';

/** The cap on what one profile may have waiting or in flight at once. */
const ACTIVE_RUN_LIMIT = 32;

const active = (run: Run) => run.status === 'running' || run.status === 'queued';

export class Runs {
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

  /** Whether this profile already has a model for this activity, or one to fall back on. */
  private async configured(
    profileId: string,
    activity: 'conversation' | 'channel',
  ): Promise<boolean> {
    const defaults = await readModelDefaults(this.store.db, profileId, nowIso(this.clock));

    return Boolean(defaults[activity] ?? defaults.conversation);
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
    const { continuationOf, activity = 'conversation', call, group, author } = options;
    const parsed = submitSchema.parse(input);
    const data = {
      ...parsed,
      text: [parsed.text, ...(parsed.mediaIds ?? []).map(mediaMarker)].filter(Boolean).join('\n'),
    };

    // Choosing a model for an owner who has not can reach the provider, and the profile lock
    // must not be held across a network call — so it is resolved before the transaction and
    // used only if nothing is configured by the time the transaction reads it.
    const automatic =
      data.model || (await this.configured(profileId, activity))
        ? null
        : await this.fallback?.pick();

    return this.store.transaction(profileId, async (tx) => {
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

      await this.sessions.session(profileId, sessionId, tx);

      await bindMedia(tx, profileId, sessionId, data.mediaIds ?? []);

      const duplicate = await findRunByRequestKey(tx, profileId, sessionId, data.requestKey);

      if (duplicate) {
        return this.sameRequest(duplicate, data.text, data.model);
      }

      const inFlight = await findActiveSessionRun(tx, profileId, sessionId);

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

        await appendSteer(tx, inFlight.id, data.text);

        return inFlight;
      }

      const defaults = await readModelDefaults(tx, profileId, nowIso(this.clock));
      let selection =
        data.model ?? defaults[activity] ?? defaults.conversation ?? automatic ?? null;
      let chosen: Awaited<ReturnType<typeof this.providers.selectedModel>> | null = null;
      if (selection) {
        try {
          chosen = await this.providers.selectedModel(selection, tx);
        } catch (error) {
          if (data.model) throw error;
          selection = null;
        }
      }
      // No list is invented here: which models a key can call is the provider's answer, so a
      // run needs either a model the owner chose or one picked from what a provider reports.
      if (!chosen && !profile.model.apiKeyEnv && !profile.model.providerId) {
        throw new GatewayError(
          409,
          'No model is available. Configure a provider, or choose one under Model defaults.',
        );
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

      await recordEvent(
        tx,
        this.clock,
        profileId,
        'run.queued',
        { sessionId, input: data.text },
        run.id,
      );

      return run;
    });
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

  async cancel(profileId: string, runId: string) {
    return this.store.transaction(profileId, async (tx) => {
      const run = await this.run(profileId, runId, tx);

      if (!active(run)) {
        return run;
      }

      const final: Run = {
        ...run,
        status: 'cancelled',
        updatedAt: nowIso(this.clock),
        leaseOwner: undefined,
        leaseUntil: undefined,
      };

      await updateRun(tx, final);
      await recordEvent(tx, this.clock, profileId, 'run.cancelled', {}, runId);

      return final;
    });
  }
}
