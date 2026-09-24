import {
  AGENT_CALL_DEPTH_LIMIT,
  type AgentAnswer,
  type AgentCallOrigin,
  type AgentCard,
  agentCallSchema,
  type Run,
} from '@jian/contracts';
import { ne } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { ProfileReader } from '../profiles/port.js';
import type { RunWriter } from '../runs/port.js';
import type { PeerSessions } from '../sessions/port.js';
import type { Store } from '../storage/database.js';
import { profiles } from '../storage/schema.js';
import type { PeerAgents, RunDelivery } from './port.js';

type PeerServices = {
  profiles: ProfileReader;
  sessions: PeerSessions;
  runs: RunWriter;
  store: Store;
};

/**
 * Everything the colleague said this turn, in order. A run's output is only its closing
 * paragraph — the rest was released as it was written — so reading the output alone hands the
 * caller the last line of an answer and loses the answer.
 */
function spoken(run: Run): string {
  return [...(run.commentary ?? []), run.output ?? ''].filter(Boolean).join('\n\n');
}

function unfinished(run: Run): string {
  // The relay includes a question of up to 4,000 characters in an 8,000-character turn.
  // Quote recent progress here; the complete record stays in the colleague's session.
  const progress = spoken(run).slice(-3000);

  return [
    `could not finish: ${(run.error ?? run.status).slice(0, 500)}`,
    'Do not assume nothing was done. Earlier actions may have succeeded; verify saved progress before repeating them.',
    progress
      ? `Recent progress reported before the failure (not a final report):\n${progress}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** How long a caller waits for a colleague and how often it looks, in milliseconds. */
export type PeerTiming = { answerWithin: number; pollEvery: number };

/**
 * Long enough for a colleague to answer a question, short enough that nobody is left staring
 * at a chat. Past it the call is not lost: the answer is carried back into the asking
 * conversation when it lands, as a turn of its own.
 */
const defaultTiming: PeerTiming = { answerWithin: 45_000, pollEvery: 250 };

/**
 * Conversation between the profiles of one installation. The wall between them is made of
 * data, not of distance: the caller sends text and receives text, and every other record —
 * memories, credentials, sessions, history — stays on the side that owns it. The call becomes
 * an ordinary run on the called profile, with its own key, its own context and its own lease.
 */
export class Peers implements PeerAgents {
  /**
   * Set after construction: channels are assembled around the services this one belongs to.
   * Absent in a gateway with no channels, where a late answer stays in the transcript.
   */
  private deliveries?: RunDelivery;

  useDeliveries(deliveries: RunDelivery): void {
    this.deliveries = deliveries;
  }

  constructor(
    private readonly services: PeerServices,
    private readonly clock: Clock = Date.now,
    private readonly timing: PeerTiming = defaultTiming,
  ) {}

  /**
   * Name and summary: what an agent does, never how it was told to do it. The select list is
   * the wall itself — instructions, identity, skills, memories and history are not read here,
   * so nothing to hide ever reaches this side.
   */
  async agents(profileId: string): Promise<AgentCard[]> {
    return this.services.store.db
      .select({ id: profiles.id, name: profiles.name, summary: profiles.summary })
      .from(profiles)
      .where(ne(profiles.id, profileId))
      .orderBy(profiles.createdAt)
      .limit(100);
  }

  async ask(run: Run, input: unknown, signal?: AbortSignal): Promise<AgentAnswer> {
    const data = agentCallSchema.parse(input);
    const origin = this.address(run, data.toProfileId);
    const callee = await this.services.profiles.profile(data.toProfileId);

    const session = await this.services.sessions.peerSession(
      callee.id,
      run.profileId,
      `Agent · ${run.profile.name}`,
    );

    // The same thread from this side. Without it the agent that asked has no record of what it
    // asked or what came back, and cannot read its own half of a conversation it is in.
    const mine = await this.services.sessions.peerSession(
      run.profileId,
      callee.id,
      `Agent · ${callee.name}`,
    );

    await this.services.sessions.record(run.profileId, mine.id, run.id, 'assistant', data.text);

    // Both sides record the call so the owner can audit who spoke to whom. A retried request
    // key records the attempt again and still reaches the single run the first one created.
    await this.record(run.profileId, run.id, 'agent.call.sent', {
      toProfileId: callee.id,
      toName: callee.name,
      depth: origin.depth,
    });

    const answering = await this.services.runs.submit(
      callee.id,
      session.id,
      { text: data.text, requestKey: data.requestKey },
      { call: origin },
    );

    await this.record(callee.id, answering.id, 'agent.call.received', {
      fromProfileId: origin.fromProfileId,
      fromName: origin.fromName,
      sessionId: session.id,
      depth: origin.depth,
    });

    const answer = await this.answer(callee.id, answering.id, callee.name, run.sessionId, signal);

    if (answer.status === 'answered' && answer.text) {
      await this.services.sessions.record(run.profileId, mine.id, run.id, 'user', answer.text);
    }

    return { fromProfileId: callee.id, fromName: callee.name, ...answer };
  }

  /**
   * Where the call sits in its chain. Two limits end a conversation that would otherwise cost
   * money forever: the depth budget, inherited from the run that is asking rather than reset
   * at each hop, and the chain itself — an agent that already answered here is not asked
   * again, so nobody reopens what they closed and no circle can form.
   */
  private address(run: Run, toProfileId: string): AgentCallOrigin {
    const chain = run.call?.chain ?? [run.profileId];
    const depth = (run.call?.depth ?? 0) + 1;

    if (toProfileId === run.profileId) {
      throw new GatewayError(400, 'An agent cannot call itself');
    }

    if (depth > AGENT_CALL_DEPTH_LIMIT) {
      throw new GatewayError(
        429,
        `Agent call budget spent: this conversation is already ${AGENT_CALL_DEPTH_LIMIT} calls deep. Answer with what you have.`,
      );
    }

    if (chain.includes(toProfileId)) {
      throw new GatewayError(
        409,
        'That agent already spoke in this conversation and will not be asked again. Answer with what you have.',
      );
    }

    return {
      fromProfileId: run.profileId,
      fromName: run.profile.name,
      fromRunId: run.id,
      fromSessionId: run.sessionId,
      depth,
      chain: [...chain, toProfileId],
    };
  }

  /**
   * The answer is the run's own output, read from the called profile's record. Waiting rather
   * than executing keeps the run where it belongs: the worker that owns that profile runs it,
   * with its lease, its checkpoints and its recovery. A caller that gives up leaves the run
   * alive; it is the called profile's work, not the caller's.
   */
  private async answer(
    profileId: string,
    runId: string,
    name: string,
    fromSessionId: string,
    signal?: AbortSignal,
  ): Promise<{ status: 'answered' | 'waiting'; text: string }> {
    const deadline = this.clock() + this.timing.answerWithin;

    for (;;) {
      const current = await this.services.runs.run(profileId, runId);

      if (current.status === 'completed') {
        return { status: 'answered', text: spoken(current) };
      }

      if (current.status !== 'queued' && current.status !== 'running') {
        throw new GatewayError(502, `${name} could not answer: ${unfinished(current)}`);
      }

      signal?.throwIfAborted();

      // Waiting longer than this holds a run, a lease and a chat open for work that belongs to
      // someone else. The answer is addressed to the asking conversation and released here.
      if (this.clock() >= deadline) {
        await this.services.runs.relayTo(profileId, runId, fromSessionId);

        return {
          status: 'waiting',
          text: `${name} is still working on it. Their answer will arrive in this conversation on its own, as a message from them — say so, and do not ask them again.`,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, this.timing.pollEvery));
    }
  }

  /**
   * Carries a late answer into the conversation that asked. It arrives there as an ordinary
   * turn, so the agent that asked is the one who decides how to pass it on.
   */
  async deliverLate(profileId: string, runId: string): Promise<void> {
    const run = await this.services.runs.run(profileId, runId);

    if (!run.relayTo || !run.call) {
      return;
    }

    const said = run.status === 'completed' ? spoken(run) : unfinished(run);

    await this.services.runs.relayTo(profileId, runId, null);

    const caller = await this.services.profiles.profile(profileId);

    const carried = await this.services.runs.submit(
      run.call.fromProfileId,
      run.relayTo,
      {
        text: [
          `${caller.name} answered the question you left with them.`,
          `You asked: ${run.input}`,
          `They replied: ${said}`,
        ].join('\n\n'),
        requestKey: `peer-answer:${runId}`,
      },
      { activity: 'channel' },
    );

    // Without this the answer reaches the transcript and stops there: nothing on the chat is
    // waiting for a run the person never sent a message to start.
    await this.deliveries?.deliverRun(run.call.fromProfileId, run.relayTo, carried.id);

    // The thread this caller keeps with the colleague: an answer that arrived late belongs
    // there as much as one that arrived in time, or its half has the question and no reply.
    const thread = await this.services.sessions.peerSession(
      run.call.fromProfileId,
      profileId,
      `Agent · ${caller.name}`,
    );

    await this.services.sessions
      .record(run.call.fromProfileId, thread.id, carried.id, 'user', said)
      .catch(() => {});
  }

  private async record(profileId: string, runId: string, type: string, data: unknown) {
    await this.services.store.transaction(profileId, (tx) =>
      recordEvent(tx, this.clock, profileId, type, data, runId),
    );
  }
}
