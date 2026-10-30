import { randomUUID } from 'node:crypto';
import {
  activityQuerySchema,
  continuationSchema,
  GATEWAY_SESSION_CHANNEL,
  type Message,
  type ModelSelection,
  type Run,
  type RunApproval,
  runAnswerSchema,
  runApprovalInputSchema,
  type Session,
  submitSchema,
  TASK_SESSION_CHANNEL,
} from '@jian/contracts';
import { resumePrompt } from '../agent/ask-user.js';
import { approvalResumePrompt } from '../agent/guard.js';
import { isChatChannel } from '../channels/kinds.js';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError, NoModelAvailable } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { bindMedia, mediaMarker } from '../media/repository.js';
import type { ProfileReader } from '../profiles/port.js';
import type { ModelFallback } from '../providers/fallback.js';
import type { ProviderSelection } from '../providers/port.js';
import { readModelDefaults, writeModelDefaults } from '../providers/repository.js';
import {
  type ObjectiveCommand,
  objectiveAt,
  parseObjectiveCommand,
} from '../sessions/objective.js';
import type { SessionReader } from '../sessions/port.js';
import {
  insertMessage,
  parseCavemanMode,
  parsePonytailMode,
  setCavemanMode,
  setPonytailMode,
  setSessionModel,
  setSessionObjective,
} from '../sessions/repository.js';
import type { Queryable, Store } from '../storage/database.js';
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
  readRunAction,
  setRelayTo,
  updateRun,
  writeRunAction,
} from './repository.js';

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
    const defaults = await readModelDefaults(this.store.db, nowIso(this.clock));
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
      await options.beforeSubmit?.(tx);
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

      const waiting = await findWaitingSessionRun(tx, profileId, sessionId);

      // Answering a mid-run question resumes work; it is not a steer and not a bare "continue".
      if (waiting?.question) {
        const resumeKey = `ask-answer:${waiting.id}`;
        const answered = await findRunByRequestKey(tx, profileId, sessionId, resumeKey);
        if (answered) return this.sameRequest(answered, data.text, data.model);

        if (modeChange) await setPonytailMode(tx, profileId, sessionId, modeChange);
        if (cavemanChange) await setCavemanMode(tx, profileId, sessionId, cavemanChange);
        await this.applyObjectiveOnSubmit(
          tx,
          profileId,
          sessionId,
          session,
          objectiveCommand,
          fromPerson,
        );
        return this.resumeWaiting(
          tx,
          profileId,
          session,
          waiting,
          options.answer ?? data.text,
          resumeKey,
          data.mediaIds,
          author,
          activity,
          data.text,
        );
      }

      // A pending approval is decided by a message only from someone who may decide it: the
      // chat's approver, through the channel, or the owner writing in the panel, which is a no
      // carrying what they wrote. Anyone else's message is ordinary and leaves it pending.
      if (waiting?.approval && !waiting.approval.decision) {
        const resumeKey = `approval:${waiting.id}`;
        const decided = await findRunByRequestKey(tx, profileId, sessionId, resumeKey);
        if (decided) return decided;

        const chat = options.approval?.id === waiting.approval.id ? options.approval : undefined;

        if (chat || options.ownerMessage) {
          return this.resumeApproval(tx, profileId, session, waiting, {
            decision: chat?.decision ?? 'reject',
            decidedBy: chat ? 'contact' : 'owner',
            note: chat ? chat.note : data.text,
            requestKey: resumeKey,
            reply: { text: data.text, ...(author ? { author } : {}) },
            activity,
          });
        }
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
          ...(options.purpose ? { purpose: options.purpose } : {}),
          createdAt: nowIso(this.clock),
        });

        if (modeChange) await setPonytailMode(tx, profileId, sessionId, modeChange);
        if (cavemanChange) await setCavemanMode(tx, profileId, sessionId, cavemanChange);
        await this.applyObjectiveOnSubmit(
          tx,
          profileId,
          sessionId,
          session,
          objectiveCommand,
          fromPerson,
        );

        await appendSteer(tx, inFlight.id, data.text);

        return inFlight;
      }

      const defaults = await readModelDefaults(tx, nowIso(this.clock));
      const candidates = data.model
        ? [data.model]
        : [session.model, defaults[activity] ?? defaults.conversation, automatic];
      let selection: ModelSelection | null = null;
      let chosen: Awaited<ReturnType<ProviderSelection['selectedModel']>> | null = null;

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
      const selectedAutomatically = selection === automatic;
      if (chosen && selection && session.channel === GATEWAY_SESSION_CHANNEL) {
        const reasoningEfforts =
          this.providers.capabilities?.(chosen.config).reasoningEfforts ?? [];
        const defaultEffort = reasoningEfforts.includes('low') ? 'low' : undefined;
        if (!selection.reasoningEffort && defaultEffort) {
          selection = { ...selection, reasoningEffort: defaultEffort };
          chosen = await this.providers.selectedModel(selection, tx);
        }
        if (JSON.stringify(session.model) !== JSON.stringify(selection)) {
          await setSessionModel(tx, profileId, sessionId, selection);
          await recordEvent(tx, this.clock, profileId, 'session.model', {
            sessionId,
            model: { providerId: selection.providerId, modelId: selection.modelId },
          });
        }
      }
      // No list is invented here: which models a key can call is the provider's answer, so a
      // run needs either a model the owner chose or one picked from what a provider reports.
      if (!chosen && !profile.model.apiKeyEnv && !profile.model.providerId) {
        throw new NoModelAvailable();
      }

      // A model picked here becomes the profile's default, so the panel agrees with what just
      // ran and the next run does not have to choose again.
      if (chosen && selection && selectedAutomatically) {
        await writeModelDefaults(
          tx,
          { ...defaults, conversation: selection },
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
        ...(options.purpose ? { purpose: options.purpose } : {}),
        createdAt: nowIso(this.clock),
      };

      await insertMessage(tx, message);
      if (modeChange) await setPonytailMode(tx, profileId, sessionId, modeChange);
      if (cavemanChange) await setCavemanMode(tx, profileId, sessionId, cavemanChange);
      await this.applyObjectiveOnSubmit(
        tx,
        profileId,
        sessionId,
        session,
        objectiveCommand,
        fromPerson,
      );

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
        // Written for the agent, reconciliation and all: the conversation shows what it does next.
        purpose: 'resume',
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

  /**
   * The panel's decision on a waiting action. A chat channel's conversation is decided in its
   * chat, by a contact the owner allowed to approve, so this route refuses it: an owner who
   * wants to approve from here gives the conversation full access instead.
   */
  async decideApproval(profileId: string, runId: string, input: unknown) {
    const data = runApprovalInputSchema.parse(input);
    const waiting = await this.run(profileId, runId);
    if (waiting.subagent) throw new GatewayError(403, 'Subagents are managed by the agent');

    const session = await this.sessions.session(profileId, waiting.sessionId);
    if (isChatChannel(session.channel)) {
      throw new GatewayError(403, 'This conversation is approved in its own chat');
    }

    const resume = await this.store.transaction(profileId, async (tx) => {
      const requestKey = data.requestKey ?? `approval:${waiting.id}`;
      const duplicate = await findRunByRequestKey(tx, profileId, waiting.sessionId, requestKey);
      if (duplicate) {
        // The same key again is the same decision; a different one under it is a mistake.
        const approval = (await findRun(tx, profileId, runId))?.approval;
        if (approval?.decision !== (data.decision === 'approve' ? 'approved' : 'rejected')) {
          throw new GatewayError(409, 'Request key was already used for a different decision');
        }
        return duplicate;
      }

      const fresh = await findRun(tx, profileId, runId);
      if (fresh?.status !== 'waiting' || !fresh.approval || fresh.approval.decision) {
        throw new GatewayError(409, 'That run is not waiting for approval');
      }

      return this.resumeApproval(tx, profileId, session, fresh, {
        decision: data.decision,
        decidedBy: 'owner',
        requestKey,
        activity: session.channel === GATEWAY_SESSION_CHANNEL ? 'conversation' : 'channel',
      });
    });

    if (session.channel !== GATEWAY_SESSION_CHANNEL && session.channel !== 'learning') {
      await this.deliveries?.deliverRun(profileId, resume.sessionId, resume.id);
    }

    return resume;
  }

  async cancel(profileId: string, runId: string, transaction?: Queryable) {
    const write = async (tx: Queryable) => {
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
      // A cancelled run takes its pending action with it: nothing can approve it any more.
      await writeRunAction(tx, runId, null);
      await recordEvent(tx, this.clock, profileId, 'run.cancelled', {}, runId);

      return final;
    };
    return transaction ? write(transaction) : this.store.transaction(profileId, write);
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
    // What the person wrote, when the answer it stands for differs: "2" for the second choice.
    said: string = answer,
  ): Promise<Run> {
    const question = waiting.question;
    if (!question) throw new GatewayError(409, 'That run is not waiting for an answer');

    const closed: Run = {
      ...waiting,
      status: 'completed',
      updatedAt: nowIso(this.clock),
      // The question stays on the parked run with its answer, so it still reads as a question
      // with the answer marked; the run's status, not the field, says whether it waits.
      question: {
        ...question,
        answer,
        answeredAt: nowIso(this.clock),
        answeredBy: activity === 'channel' ? 'contact' : 'owner',
      },
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
      content: said,
      ...(author ? { author } : {}),
      purpose: 'answer',
      createdAt: nowIso(this.clock),
    });

    const { chosen, selection } = await this.continuationModel(tx, session, waiting, activity);

    if ((await countActiveRuns(tx, profileId)) >= ACTIVE_RUN_LIMIT) {
      throw new GatewayError(429, 'Profile run limit reached');
    }

    const text = resumePrompt(question, answer);
    const run = this.continuation(waiting, requestKey, text, chosen, selection);

    const collided = await insertRun(tx, run);
    if (collided) return this.sameRequest(collided, text);

    await bindMedia(tx, profileId, waiting.sessionId, mediaIds ?? [], run.id);
    await this.queueContinuation(tx, profileId, waiting, run);

    return run;
  }

  /**
   * Decides a waiting action and queues the turn that carries on. The decision is kept on the
   * parked run; on a yes, the stored call moves onto the continuation, which runs it once before
   * its model is called, and on a no it is dropped, so a rejected action has nothing left to run.
   */
  private async resumeApproval(
    tx: Queryable,
    profileId: string,
    session: Session,
    waiting: Run,
    decision: {
      decision: 'approve' | 'reject';
      decidedBy: 'owner' | 'contact';
      note?: string;
      requestKey: string;
      /** The message that decided it, when one did. */
      reply?: { text: string; author?: Message['author'] };
      activity: 'conversation' | 'channel';
    },
  ): Promise<Run> {
    if (!waiting.approval || waiting.approval.decision) {
      throw new GatewayError(409, 'That run is not waiting for approval');
    }

    const action = await readRunAction(tx, waiting.id);
    const approve = decision.decision === 'approve';
    if (approve && action?.state !== 'pending') {
      throw new GatewayError(409, 'The action to approve is no longer available');
    }

    const note = decision.note?.trim().slice(0, 500);
    const approval: RunApproval = {
      ...waiting.approval,
      decision: approve ? 'approved' : 'rejected',
      decidedAt: nowIso(this.clock),
      decidedBy: decision.decidedBy,
      ...(note ? { note } : {}),
    };

    await updateRun(tx, {
      ...waiting,
      status: 'completed',
      approval,
      updatedAt: nowIso(this.clock),
    });
    await writeRunAction(tx, waiting.id, null);
    await recordEvent(
      tx,
      this.clock,
      profileId,
      approve ? 'run.approved' : 'run.rejected',
      { approval },
      waiting.id,
    );

    if (decision.reply) {
      await insertMessage(tx, {
        id: randomUUID(),
        profileId,
        sessionId: waiting.sessionId,
        runId: waiting.id,
        role: 'user',
        content: decision.reply.text,
        ...(decision.reply.author ? { author: decision.reply.author } : {}),
        purpose: 'answer',
        createdAt: nowIso(this.clock),
      });
    }

    const { chosen, selection } = await this.continuationModel(
      tx,
      session,
      waiting,
      decision.activity,
    );

    if ((await countActiveRuns(tx, profileId)) >= ACTIVE_RUN_LIMIT) {
      throw new GatewayError(429, 'Profile run limit reached');
    }

    const text = approvalResumePrompt(approval);
    const run = this.continuation(waiting, decision.requestKey, text, chosen, selection);
    const collided = await insertRun(tx, run);
    if (collided) return collided;

    if (approve && action) {
      await writeRunAction(tx, run.id, { ...action, state: 'approved' });
    }
    await this.queueContinuation(tx, profileId, waiting, run);

    return run;
  }

  /** The model a parked run carries on with: its own choice first, so a resume never switches. */
  private async continuationModel(
    tx: Queryable,
    session: Session,
    waiting: Run,
    activity: 'conversation' | 'channel',
  ) {
    const profile = waiting.profile;
    const defaults = await readModelDefaults(tx, nowIso(this.clock));
    const candidates = [
      waiting.modelSelection,
      session.model,
      defaults[activity] ?? defaults.conversation,
    ];
    let selection: ModelSelection | null = null;
    let chosen: Awaited<ReturnType<ProviderSelection['selectedModel']>> | null = null;

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

    return { chosen, selection };
  }

  /** The turn that carries a parked run on, on its model, in its chain and its room. */
  private continuation(
    waiting: Run,
    requestKey: string,
    text: string,
    chosen: Awaited<ReturnType<ProviderSelection['selectedModel']>> | null,
    selection: ModelSelection | null,
  ): Run {
    return {
      id: randomUUID(),
      profileId: waiting.profileId,
      sessionId: waiting.sessionId,
      requestKey,
      input: text,
      profile: waiting.profile,
      ...(chosen ? { model: chosen.config, contextPolicy: chosen.policy } : {}),
      ...(selection ? { modelSelection: selection } : {}),
      ...(waiting.call ? { call: waiting.call } : {}),
      ...(waiting.group ? { group: waiting.group } : {}),
      status: 'queued',
      continuationOf: waiting.id,
      createdAt: nowIso(this.clock),
      updatedAt: nowIso(this.clock),
    };
  }

  private async queueContinuation(tx: Queryable, profileId: string, waiting: Run, run: Run) {
    await insertMessage(tx, {
      id: randomUUID(),
      profileId,
      sessionId: waiting.sessionId,
      runId: run.id,
      role: 'user',
      content: run.input,
      // The agent's note to carry on: it reads it, the conversation does not show it.
      purpose: 'resume',
      createdAt: nowIso(this.clock),
    });

    await recordEvent(
      tx,
      this.clock,
      profileId,
      'run.queued',
      { sessionId: waiting.sessionId, input: run.input, resumedFrom: waiting.id },
      run.id,
    );
  }

  /**
   * Explicit owner commands set/close the session objective. Casual chat never seeds one —
   * that is the agent's job via set_session_objective (or the session API / /objective).
   * A person message while blocked only resumes the existing goal; it does not replace the text.
   */
  private async applyObjectiveOnSubmit(
    tx: Queryable,
    profileId: string,
    sessionId: string,
    session: Session,
    command: ObjectiveCommand | undefined,
    fromPerson: boolean,
  ) {
    if (session.channel === TASK_SESSION_CHANNEL) return;
    const at = nowIso(this.clock);
    const current = session.objective;

    if (command?.action === 'set') {
      await setSessionObjective(
        tx,
        profileId,
        sessionId,
        objectiveAt(command.text, 'open', at, { continuations: 0 }),
      );
      return;
    }
    if (command?.action === 'done') {
      if (!current?.text) return;
      await setSessionObjective(
        tx,
        profileId,
        sessionId,
        objectiveAt(current.text, 'done', at, { continuations: current.continuations }),
      );
      return;
    }
    if (command?.action === 'cancel') {
      if (!current?.text) return;
      await setSessionObjective(
        tx,
        profileId,
        sessionId,
        objectiveAt(current.text, 'cancelled', at, { continuations: current.continuations }),
      );
      return;
    }

    if (!fromPerson) return;

    // Owner/channel reply while blocked: resume the same goal — never promote chat into a new title.
    if (current?.status === 'blocked' && current.text) {
      await setSessionObjective(
        tx,
        profileId,
        sessionId,
        objectiveAt(current.text, 'open', at, { continuations: 0 }),
      );
    }
  }
}
