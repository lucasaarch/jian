'use client';

import { MESSAGES_FIRST_PAGE, type RunProgress } from '@jian/contracts';
import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  Message,
  Person,
  Run,
  RunApproval,
  RunQuestion,
  Subagent,
  ToolStep,
} from '../../../lib/api';
import type { HistorySnapshot } from '../kept-history';
import { running } from '../status';
import { answers, joinHistory, overTurns, sameMessage, sameValue, turnOf } from './turns';

/** What a turn asked the owner to decide or answer. */
export type Asks = { approval?: RunApproval; question?: RunQuestion };

/**
 * One conversation as the panel knows it. Every collection is replaced, never changed in place,
 * and a read keeps the values of what it did not touch, so a row drawn from them stays as it was.
 */
export type ConversationState = {
  /** The pages read so far, oldest first. */
  messages: Message[];
  /** Each turn's tools, by runId. */
  tools: Map<string, ToolStep[]>;
  asks: Map<string, Asks>;
  /** In an agent conversation this profile started, the other agent's tools, by its runId. */
  callTools: Map<string, ToolStep[]>;
  /** The conversation's latest turn. Its progress lives in `live`, so text never touches it. */
  run?: Run;
  /** The other agent's turn while it answers a question this profile carried to it. */
  callRun?: Run;
  /**
   * What the turn at work is saying now. The only field a text update changes: what draws it
   * is all that redraws as an answer is written.
   */
  live?: { runId: string; progress: RunProgress };
  subagents: Subagent[];
  people: Map<string, Person>;
  /** Turns whose tools were read after they ended, here and the other agent's: final. */
  ended: { runs: Set<string>; calls: Set<string> };
  /**
   * The row key a stored message inherited instead of its id: the outbox key it was sent with,
   * or the live row's key when it is the answer that row was writing. Its element stays.
   */
  keys: Map<string, string>;
  /** The live row's key is `live:${liveSerial}`; it moves on when an answer takes the key. */
  liveSerial: number;
  /**
   * Turns sent from here that no read has brought back yet, with when the gateway was seen to
   * take each, as an ISO time.
   */
  awaited: Map<string, string>;
  loading: boolean;
  /** Why the first read failed, while nothing is on screen. */
  error: string;
  /** The last read failed: what is on screen stays, but may be out of date. */
  behind: boolean;
  /** The last read of the tools failed: some of what the agent did may be missing. */
  toolsUnread: boolean;
  earlier: 'idle' | 'reading' | 'failed';
  atBeginning: boolean;
};

type ConversationActions = {
  /** The latest page. `fresh` starts over from it, as a reload the owner asked for does. */
  pageRead(page: Message[], fresh: boolean): void;
  /** The page before the oldest message known. */
  earlierRead(page: Message[]): void;
  turnsRead(asked: string[], steps: [string, ToolStep[]][], asks: [string, Asks][]): void;
  callsRead(asked: string[], steps: [string, ToolStep[]][]): void;
  /** The conversation's latest turn, as a read found it. */
  runRead(run: Run | undefined): void;
  /** What the stream says a turn is doing now. Touches nothing but `live`. */
  progress(runId: string, progress: RunProgress): void;
  subagentsRead(list: Subagent[]): void;
  peopleRead(list: Person[]): void;
  /** A message sent from here was stored: its row keeps the key it was drawn with. */
  sent(messageId: string, outboxKey: string): void;
  /** One message as the gateway has it now, after a reaction: only its row draws again. */
  messageChanged(message: Message): void;
  patch(
    change: Partial<
      Pick<
        ConversationState,
        | 'loading'
        | 'error'
        | 'behind'
        | 'toolsUnread'
        | 'earlier'
        | 'atBeginning'
        | 'callRun'
        | 'awaited'
      >
    >,
  ): void;
  markEnded(runs: string[], calls: string[]): void;
  /** What a kept cache holds: the latest page only, with its turns' tools. */
  snapshot(): HistorySnapshot;
};

export type ConversationStore = StoreApi<ConversationState & ConversationActions>;

type Live = ConversationState['live'];

/**
 * Whether progress told of a turn replaces what is known of it: only when strictly newer. A read
 * that began before the latest event must not step the text back, and an event told again after
 * a handover, with the `updatedAt` the cleared line kept, must not bring handed-over text back.
 */
const newer = (known: Live, runId: string, progress: RunProgress) =>
  known?.runId !== runId || progress.updatedAt > known.progress.updatedAt;

/** The live line after a read of the run: none once it stopped working. */
function liveAfter(known: Live, run: Run, progress: RunProgress | undefined): Live {
  if (!running(run)) return undefined;
  const mine = known?.runId === run.id ? known : undefined;
  if (!progress || !newer(mine, run.id, progress)) return mine;

  return { runId: run.id, progress };
}

/**
 * The page joined to what is known, keeping every message object the read brought back unchanged,
 * and the array itself when nothing changed: rows compare by identity, so only what moved redraws.
 */
function joined(known: Message[], page: Message[], fresh: boolean): Message[] {
  const byId = new Map(known.map((message) => [message.id, message]));
  const next = joinHistory(fresh ? [] : known, page).map((message) => {
    const was = byId.get(message.id);
    return was && sameMessage(was, message) ? was : message;
  });

  return next.length === known.length && next.every((message, at) => message === known[at])
    ? known
    : next;
}

/**
 * The agents a poll found, keeping each known one it found unchanged, and the list itself when
 * none changed: a poll runs every 1.5 s while one works, and the rows that show the others must
 * not be drawn again for it.
 */
function steadyAgents(known: Subagent[], read: Subagent[]): Subagent[] {
  const byRun = new Map(known.map((agent) => [agent.runId, agent]));
  const next = read.map((agent) => {
    const was = byRun.get(agent.runId);
    return was && sameValue(was, agent) ? was : agent;
  });

  return next.length === known.length && next.every((agent, at) => agent === known[at])
    ? known
    : next;
}

/** A run without its progress, which only `live` carries. */
function bare(run: Run): Run {
  const { progress: _progress, ...rest } = run;
  return rest;
}

export function createConversationStore(kept?: HistorySnapshot): ConversationStore {
  return createStore<ConversationState & ConversationActions>()((set, get) => ({
    messages: kept?.messages ?? [],
    tools: new Map(kept?.tools),
    asks: new Map(kept?.asks),
    callTools: new Map(kept?.callTools),
    ...(kept?.run
      ? { run: bare(kept.run), live: liveAfter(undefined, kept.run, kept.run.progress) }
      : {}),
    subagents: kept?.subagents ?? [],
    people: new Map(kept?.people.map((person) => [person.id, person])),
    ended: { runs: new Set(), calls: new Set() },
    keys: new Map(),
    liveSerial: 0,
    awaited: new Map(),
    loading: !kept,
    error: '',
    behind: false,
    toolsUnread: false,
    earlier: 'idle',
    atBeginning: false,

    pageRead: (page, fresh) =>
      set((state) => {
        const messages = joined(state.messages, page, fresh);
        // A read that brings something is a read that worked: what it shows is current.
        const read = { messages, loading: false, error: '', behind: false };
        const restart = fresh
          ? {
              ended: { runs: new Set<string>(), calls: new Set<string>() },
              atBeginning: false,
              earlier: 'idle' as const,
            }
          : {};

        return { ...read, ...restart, ...handover(state, messages) };
      }),

    earlierRead: (page) =>
      set((state) => {
        const known = new Set(state.messages.map((message) => message.id));
        // A gateway that cannot page answers its latest messages again: nothing new, so stop.
        const before = page.filter((message) => !known.has(message.id));

        return {
          messages: before.length ? [...before, ...state.messages] : state.messages,
          earlier: 'idle',
          atBeginning: page.length < MESSAGES_FIRST_PAGE || !before.length,
        };
      }),

    turnsRead: (asked, steps, asks) =>
      set((state) => ({
        tools: overTurns(state.tools, asked, steps),
        asks: overTurns(state.asks, asked, asks),
      })),

    callsRead: (asked, steps) =>
      set((state) => ({ callTools: overTurns(state.callTools, asked, steps) })),

    runRead: (run) =>
      set((state) =>
        run
          ? { run: bare(run), live: liveAfter(state.live, run, run.progress) }
          : { run: undefined, live: undefined },
      ),

    progress: (runId, progress) =>
      set((state) => (newer(state.live, runId, progress) ? { live: { runId, progress } } : {})),

    subagentsRead: (list) => set((state) => ({ subagents: steadyAgents(state.subagents, list) })),

    peopleRead: (list) => set({ people: new Map(list.map((person) => [person.id, person])) }),

    sent: (messageId, outboxKey) =>
      set((state) =>
        state.keys.get(messageId) === outboxKey
          ? {}
          : { keys: new Map(state.keys).set(messageId, outboxKey) },
      ),

    messageChanged: (message) =>
      set((state) =>
        state.messages.some((known) => known.id === message.id)
          ? {
              messages: state.messages.map((known) => (known.id === message.id ? message : known)),
            }
          : {},
      ),

    patch: (change) => set(change),

    markEnded: (runs, calls) =>
      set((state) => ({
        ended: {
          runs: new Set([...state.ended.runs, ...runs]),
          calls: new Set([...state.ended.calls, ...calls]),
        },
      })),

    snapshot: () => {
      const { messages, tools, asks, callTools, subagents, people, run, live } = get();
      const page = messages.slice(-MESSAGES_FIRST_PAGE);
      // The turn last under way may have said nothing on the page yet; its tools go too.
      const turns = new Set([
        ...page.flatMap((message) => (message.runId ? [message.runId] : [])),
        ...(run ? [run.id] : []),
      ]);
      const calls = new Set(page.flatMap((message) => (message.call ? [message.call.runId] : [])));
      const on = <Value>(known: Map<string, Value>, among: Set<string>) =>
        [...known].filter(([turn]) => among.has(turn));

      return {
        messages: page,
        tools: on(tools, turns),
        asks: on(asks, turns),
        callTools: on(callTools, calls),
        subagents,
        people: [...people.values()],
        // The text under way goes with its run, so a conversation reopened mid-answer shows it.
        ...(run ? { run: live?.runId === run.id ? { ...run, progress: live.progress } : run } : {}),
      };
    },
  }));
}

/**
 * The answer a read brought for the turn being written takes the live row's key, so the element
 * that showed the text as it came is the one that keeps it, and the live row starts over empty
 * under a new key. Nothing was being written, nothing is handed over: the answer is new.
 */
function handover(state: ConversationState, messages: Message[]): Partial<ConversationState> {
  const live = state.live;
  if (!live) return {};
  const known = new Set(state.messages.map((message) => message.id));
  const landed = messages.filter(
    (message) => answers(message) && turnOf(message) === live.runId && !known.has(message.id),
  );
  const answer = landed.at(-1);
  if (!answer || !live.progress.text) return {};

  return {
    live: { ...live, progress: { ...live.progress, text: '' } },
    keys: new Map(state.keys).set(answer.id, `live:${state.liveSerial}`),
    liveSerial: state.liveSerial + 1,
  };
}

export const ConversationContext = createContext<ConversationStore | null>(null);

/** A part of the conversation on screen, redrawn only when what `select` returns changes. */
export function useConversation<T>(select: (state: ConversationState) => T): T {
  const store = useContext(ConversationContext);
  if (!store) throw new Error('useConversation needs a ConversationContext around it.');
  return useStore(store, select);
}
