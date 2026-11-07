import { MESSAGES_FIRST_PAGE } from '@jian/contracts';
import { toast } from 'sonner';
import type { GatewayApi, Message, ToolStep } from '../../../lib/api';
import { running } from '../status';
import { released } from './live-text';
import type { Asks, ConversationStore } from './store';
import { endedTurns } from './turns';

/** What the conversation reads from the gateway: the part of `History`'s `api` it uses. */
export type HistoryApi = Pick<GatewayApi, 'messages' | 'activities'> &
  Partial<Pick<GatewayApi, 'people' | 'timeline' | 'run' | 'conversationSubagents'>>;

export type Reader = {
  /** The latest page, the turn at work, people and subagents, then the page's unended tools. */
  latest(): Promise<void>;
  /** The page before the oldest message known, with its tools. Never two at once. */
  earlier(): Promise<void>;
  /** The tools of these turns of this conversation. Ended ones are final and skipped. */
  turns(runIds: string[]): Promise<void>;
  subagents(): Promise<void>;
  /** One turn as the gateway has it now, for a stream that told of progress without saying it. */
  run(runId: string): Promise<void>;
  /** The other agent's turn while it answers the question this profile carried to it. */
  call(): Promise<void>;
  /** Every read under way, and every later one, lands nowhere: another conversation is shown. */
  stop(): void;
};

type Ended = { runs: Set<string>; calls: Set<string> };

/**
 * The last question this profile carried to another agent, while its answer has not come back.
 * That agent's work reaches this profile's stream only when it ends, so it is followed by reads.
 */
export function pendingCall(messages: Message[]) {
  const call = messages
    .filter((message) => message.call && message.role === 'assistant')
    .at(-1)?.call;
  if (!call) return undefined;
  const back = messages.some(
    (message) => message.role === 'user' && message.call?.runId === call.runId,
  );
  return back ? undefined : call;
}

/**
 * One read at a time. What asks while one is under way gets one more after it, with everything
 * asked meanwhile, however many asked: overlapping reads each downloaded and drew the whole
 * conversation. The promise a caller gets settles once what it asked for has been read.
 */
function singleFlight<Arg>(work: (args: Arg[]) => Promise<void>, stopped: () => boolean) {
  let flight: Promise<void> | undefined;
  let again = false;
  let pending: Arg[] = [];

  return (args: Arg[] = []) => {
    pending.push(...args);
    if (flight) {
      again = true;
      return flight;
    }
    flight = (async () => {
      try {
        do {
          again = false;
          const now = pending;
          pending = [];
          await work(now);
        } while (again && !stopped());
      } finally {
        flight = undefined;
        pending = [];
      }
    })();
    return flight;
  };
}

export function createReader(options: {
  api: HistoryApi;
  profileId: string;
  sessionId: string;
  group: boolean;
  store: ConversationStore;
  /** How many reloads the owner has asked for: a change reads the conversation afresh. */
  reloads: () => number;
}): Reader {
  const { api, profileId, sessionId, group, store } = options;
  let stopped = false;
  const isStopped = () => stopped;
  // The last reload the owner asked for that has had its outcome.
  let answered = options.reloads();
  const state = () => store.getState();
  // Something is on screen, kept or read: a failed read leaves it there rather than covering it
  // with an error. Nothing yet is loading; a first read that failed left its error.
  const shown = () => !state().loading && !state().error;

  // Reads of one turn's tools overlap: a step's, the latest read's, the other agent's poll, each
  // its own single flight, answered in any order. Each read is numbered as it is sent, and what it
  // says of a turn lands only if no read sent after it has landed first: a slow answer never
  // steps a turn's tools back, nor brings an ended turn's earlier tools over its final ones.
  let sent = 0;
  const landed = { runs: new Map<string, number>(), calls: new Map<string, number>() };
  /** The turns read number `read` may write, now taken as written by it. */
  const newest = (kind: 'runs' | 'calls', turns: string[], read: number) =>
    turns.filter((turn) => {
      if ((landed[kind].get(turn) ?? 0) > read) return false;
      landed[kind].set(turn, read);
      return true;
    });
  const only = <Value>(turns: string[], told: [string, Value][]) => {
    const kept = new Set(turns);
    return told.filter(([turn]) => kept.has(turn));
  };
  const writeTurns = (turns: string[], steps: [string, ToolStep[]][], asks: [string, Asks][]) => {
    if (turns.length) state().turnsRead(turns, only(turns, steps), only(turns, asks));
  };
  const writeCalls = (turns: string[], steps: [string, ToolStep[]][]) => {
    if (turns.length) state().callsRead(turns, only(turns, steps));
  };

  /**
   * The tools of a page of messages, asked for by that page's own turns, so an old page never
   * lacks them. The other agent's tools are read where it worked: its own session, in its profile.
   * Turns in `skip` are final and left as they are known.
   */
  const readTurns = async (page: Message[], under: string | undefined, skip: Ended) => {
    const turns = [
      ...new Set([
        ...page.flatMap((message) => (message.runId ? [message.runId] : [])),
        ...(under ? [under] : []),
      ]),
    ].filter((turn) => !skip.runs.has(turn));
    const calls = new Map<string, { profileId: string; sessionId: string; runs: string[] }>();
    for (const { call } of page) {
      if (!call || skip.calls.has(call.runId)) continue;
      const place = `${call.profileId}/${call.sessionId}`;
      const known = calls.get(place) ?? { ...call, runs: [] };
      if (!known.runs.includes(call.runId)) known.runs.push(call.runId);
      calls.set(place, known);
    }
    const number = ++sent;
    const [timeline, worked] = await Promise.all([
      // Nothing to ask: a timeline asked for no turn answers with the latest ones instead.
      api.timeline && turns.length
        ? api.timeline(profileId, sessionId, turns).catch(() => undefined)
        : Promise.resolve(api.timeline ? [] : undefined),
      api.timeline
        ? Promise.all(
            [...calls.values()].map((call) =>
              api.timeline?.(call.profileId, call.sessionId, call.runs).catch(() => undefined),
            ),
          )
        : Promise.resolve([]),
    ]);
    const steps = (timeline ?? []).map((item): [string, ToolStep[]] => [item.runId, item.steps]);
    const asked = (timeline ?? []).flatMap((item): [string, Asks][] =>
      item.approval || item.question
        ? [[item.runId, { approval: item.approval, question: item.question }]]
        : [],
    );

    return {
      number,
      turns,
      callTurns: [...calls.values()].flatMap((call) => call.runs),
      steps,
      asked,
      called: worked
        .flatMap((item) => item ?? [])
        .map((item): [string, ToolStep[]] => [item.runId, item.steps]),
      unread:
        Boolean(api.timeline) &&
        (timeline === undefined || worked.some((item) => item === undefined)),
      toolsRead: timeline !== undefined,
      callsRead: worked.every((item) => item !== undefined),
    };
  };

  const readLatest = async () => {
    const began = new Date().toISOString();
    const reloads = options.reloads();
    try {
      // The transcript is the part the owner came to see. Start its request with the supporting
      // reads, but do not make the conversation wait for a second trip to fetch its timeline.
      const pageRequest = api.messages(profileId, sessionId, { limit: MESSAGES_FIRST_PAGE });
      const supportingReads = Promise.all([
        api.activities(profileId),
        group && api.people ? api.people(profileId, sessionId) : undefined,
        api.conversationSubagents?.(profileId, sessionId) ?? [],
      ]).then(
        (result) => ({ result }),
        (failure: unknown) => ({ failure }),
      );
      const page = await pageRequest;
      if (stopped) return;
      // A reload the owner asked for starts from what the gateway says now, and nothing else.
      const fresh = answered !== reloads;
      // The page lands before the turn is read: while the turn still counts as at work, the
      // answer it brings takes over the live row's element instead of drawing a new one.
      state().pageRead(page, fresh);

      const supporting = await supportingReads;
      // Gone while it waited: another conversation is on screen now.
      if (stopped) return;
      if ('failure' in supporting) throw supporting.failure;
      const [activities, members, children] = supporting.result;
      const lastRun = activities
        .filter((activity) => activity.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(-1);
      // The turn at work is drawn now; its tools follow when the timeline answers.
      state().runRead(lastRun);
      // A turn sent before this read began is in what it read, at work or already over. Timed
      // from when the gateway took it, not the click: a read begun in between may not hold it.
      const { awaited } = state();
      if ([...awaited.values()].some((at) => at < began)) {
        state().patch({ awaited: new Map([...awaited].filter(([, at]) => at >= began)) });
      }
      const read = await readTurns(page, lastRun?.id, state().ended);
      if (stopped) return;
      // What a part that could not be read leaves as it was.
      if (read.toolsRead)
        writeTurns(newest('runs', read.turns, read.number), read.steps, read.asked);
      if (read.callsRead) writeCalls(newest('calls', read.callTurns, read.number), read.called);
      // Read once they ended, and never again: an ended turn's tools are final. A turn moves its
      // tools on every step, and asking for all of a long conversation's on each one downloaded
      // and drew megabytes for the one turn that changed.
      state().markEnded(
        read.toolsRead ? endedTurns(read.turns, page, activities) : [],
        // The other agent's answer is back: its turn there is over.
        read.callsRead
          ? read.callTurns.filter((turn) =>
              page.some((message) => message.role === 'user' && message.call?.runId === turn),
            )
          : [],
      );
      state().subagentsRead(children);
      if (members) state().peopleRead(members);
      state().patch({ toolsUnread: read.unread });
      answered = reloads;
      if (fresh) toast.success('Chat reloaded.');
    } catch (failure) {
      if (stopped) return;
      const said = failure instanceof Error ? failure.message : 'The history could not be loaded.';
      if (!shown()) {
        state().patch({ loading: false, error: said });
        return;
      }
      state().patch({ loading: false, behind: true });
      // What is on screen stays, but a reload the owner asked for does not fail in silence.
      if (answered !== reloads) {
        answered = reloads;
        toast.error(`This chat could not be reloaded: ${said}`);
      }
    }
  };

  const readTurnsOf = async (asked: string[]) => {
    const { ended } = state();
    const turns = [...new Set(asked)].filter((turn) => !ended.runs.has(turn));
    // Never ask the timeline for no turn: it answers with the latest ones instead.
    if (!turns.length || !api.timeline || stopped) return;
    const number = ++sent;
    try {
      const timeline = await api.timeline(profileId, sessionId, turns);
      if (stopped) return;
      // A turn that ended while this was read has its final tools from the read that ended it.
      const still = turns.filter((turn) => !state().ended.runs.has(turn));
      writeTurns(
        newest('runs', still, number),
        timeline.map((item): [string, ToolStep[]] => [item.runId, item.steps]),
        timeline.flatMap((item): [string, Asks][] =>
          item.approval || item.question
            ? [[item.runId, { approval: item.approval, question: item.question }]]
            : [],
        ),
      );
    } catch {
      if (!stopped) state().patch({ toolsUnread: true });
    }
  };

  const readSubagents = async () => {
    if (!api.conversationSubagents || stopped) return;
    try {
      const children = await api.conversationSubagents(profileId, sessionId);
      if (!stopped) state().subagentsRead(children);
    } catch {
      // Followed every 1.5 s while one works: the next poll, or the next read, tries again.
    }
  };

  const latest = singleFlight<never>(readLatest, isStopped);
  const turns = singleFlight<string>(readTurnsOf, isStopped);
  const subagents = singleFlight<never>(readSubagents, isStopped);

  const run = singleFlight<string>(async (asked) => {
    if (stopped) return;
    if (!api.run) {
      await latest();
      return;
    }
    let page = false;
    for (const runId of new Set(asked)) {
      const current = await api.run(profileId, runId).catch(() => undefined);
      if (stopped) return;
      if (!current || current.sessionId !== sessionId) continue;
      const before = state().live;
      // An ended turn goes through the page first, or its answer would land after the live row
      // was cleared, and be drawn as a new element instead of taking that row's.
      if (!running(current)) page = true;
      else if (state().run?.id === current.id) state().runRead(current);
      else if (current.progress) state().progress(current.id, current.progress);
      // Text that stopped going on was released as a message: the page has it.
      const after = state().live;
      if (after && released(before, after)) page = true;
    }
    if (page) await latest();
  }, isStopped);

  const call = singleFlight<never>(async () => {
    const pending = pendingCall(state().messages);
    if (!pending || !api.run || stopped) return;
    const number = ++sent;
    const [current, steps] = await Promise.all([
      api.run(pending.profileId, pending.runId).catch(() => undefined),
      api.timeline?.(pending.profileId, pending.sessionId, [pending.runId]).catch(() => undefined),
    ]);
    // Its answer came back while this was read: the read that saw it holds the final word.
    if (stopped || state().ended.calls.has(pending.runId)) return;
    state().patch({ callRun: current });
    if (steps) {
      writeCalls(
        newest('calls', [pending.runId], number),
        steps.map((item): [string, ToolStep[]] => [item.runId, item.steps]),
      );
    }
  }, isStopped);

  return {
    latest: () => latest(),
    earlier: (() => {
      // Never two at once, and none after: the scroll that asked asks again if still near the top.
      let reading = false;
      return async () => {
        const oldest = state().messages[0];
        if (reading || stopped || !oldest || state().atBeginning) return;
        reading = true;
        state().patch({ earlier: 'reading' });
        try {
          const page = await api.messages(profileId, sessionId, {
            before: oldest.id,
            limit: MESSAGES_FIRST_PAGE,
          });
          if (stopped) return;
          const known = new Set(state().messages.map((message) => message.id));
          // A gateway that cannot page answers its latest messages again: nothing new to read.
          const before = page.filter((message) => !known.has(message.id));
          const read = await readTurns(before, undefined, state().ended);
          if (stopped) return;
          if (read.toolsRead) {
            writeTurns(newest('runs', read.turns, read.number), read.steps, read.asked);
          }
          if (read.callsRead) writeCalls(newest('calls', read.callTurns, read.number), read.called);
          if (read.unread) state().patch({ toolsUnread: true });
          state().earlierRead(page);
        } catch {
          if (!stopped) state().patch({ earlier: 'failed' });
        } finally {
          reading = false;
        }
      };
    })(),
    turns: (runIds) => turns(runIds),
    subagents: () => subagents(),
    run: (runId) => run([runId]),
    call: () => call(),
    stop: () => {
      stopped = true;
    },
  };
}
