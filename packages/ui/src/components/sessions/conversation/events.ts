import { runProgressEventSchema, STREAM_OPENED_EVENT } from '@jian/contracts';
import { onlineManager } from '@tanstack/react-query';
import { subscribe } from '../../../lib/events';
import { focusInspector } from '../inspector-host';
import { running } from '../status';
import { pendingCall, type Reader } from './reader';
import type { ConversationState, ConversationStore } from './store';

/** How long events that arrive together are gathered before one read covers them all, in ms. */
const BURST_MS = 150;
/**
 * How long a turn at work may go without a word from the stream before the conversation is read
 * anyway, in ms, and the longest the wait grows to while the silence lasts.
 */
const QUIET_READ_MS = 4_000;
const QUIET_READ_MAX_MS = 30_000;
/** How often the silence is checked, in ms. */
const QUIET_CHECK_MS = 1_000;
/** How often subagents at work, and another agent answering, are read, in ms. */
const FOLLOW_MS = 1_500;

const working = (state: ConversationState) => running(state.run) || state.awaited.size > 0;
const crewWorking = (state: ConversationState) =>
  state.subagents.some((child) => child.status === 'queued' || child.status === 'running');
const callKey = (state: ConversationState) => {
  const call = pendingCall(state.messages);
  return call ? `${call.profileId} ${call.sessionId} ${call.runId}` : '';
};

/**
 * Turns what the gateway's stream says into what the conversation reads. Text under way is
 * written to the store as it is told; everything else is read, gathered over a burst, and only
 * the part that changed. Returns the way to stop following; the reader is stopped by its owner.
 */
export function followConversation(options: {
  store: ConversationStore;
  reader: Reader;
  sessionId: string;
}): () => void {
  const { store, reader, sessionId } = options;
  let gone = false;
  const wanted = {
    latest: false,
    subagents: false,
    turns: new Set<string>(),
    runs: new Set<string>(),
  };
  let burst: ReturnType<typeof setTimeout> | undefined;
  // When the stream last said something about this conversation, and when it was last read
  // without being told to, in ms.
  let streamAt = Date.now();
  let polledAt = 0;

  const flush = () => {
    const { latest, subagents, turns, runs } = wanted;
    wanted.latest = false;
    wanted.subagents = false;
    wanted.turns = new Set();
    wanted.runs = new Set();
    // The latest read covers the rest: the turn at work, its tools, and the subagents.
    if (latest) {
      void reader.latest();
      return;
    }
    if (turns.size) void reader.turns([...turns]);
    for (const runId of runs) void reader.run(runId);
    if (subagents) void reader.subagents();
  };
  const want = (change: (into: typeof wanted) => void) => {
    change(wanted);
    // Several events arrive together as a turn moves; one read covers them all.
    clearTimeout(burst);
    burst = setTimeout(flush, BURST_MS);
  };

  const stopEvents = subscribe((event) => {
    if (event.type === 'conversation.inspector.focus') {
      focusInspector(sessionId, event.data as Parameters<typeof focusInspector>[1]);
      return;
    }
    if (event.type === 'run.progress') {
      const told = runProgressEventSchema.safeParse(event.data);
      if (!told.success || told.data.sessionId !== sessionId) return;
      streamAt = Date.now();
      // At once, and with no read: the text is all that changed, and the stream carries it.
      if (told.data.progress) store.getState().progress(told.data.runId, told.data.progress);
      // A gateway older than progress in the stream says only that something changed.
      else want((into) => into.runs.add(told.data.runId));
      return;
    }
    if (event.type === STREAM_OPENED_EVENT) {
      // Whatever happened before the stream opened will not be told.
      want((into) => {
        into.latest = true;
      });
      return;
    }
    if (
      !event.type.startsWith('run.') &&
      !event.type.startsWith('session.') &&
      event.type !== 'conversation.subagent.spawned'
    )
      return;
    // A durable event reaches the panel as `{ sessionId?, parentSessionId? }` and nothing more:
    // the stream strips the rest, its run id included. A step or an end names no conversation,
    // so one that names none may be this one's, and is taken as such.
    const about = (event.data ?? {}) as { sessionId?: string; parentSessionId?: string };
    const named = about.sessionId || about.parentSessionId;
    if (named && about.sessionId !== sessionId && about.parentSessionId !== sessionId) return;
    streamAt = Date.now();
    if (event.type === 'conversation.subagent.spawned') {
      want((into) => {
        into.subagents = true;
      });
      return;
    }
    // A step moves only the turn at work: its tools are read, not the conversation. With no turn
    // known, the step may be of one this panel has not read yet, and the page tells which.
    const { live, run } = store.getState();
    const turn = live?.runId ?? run?.id;
    if (event.type === 'run.step' && turn) want((into) => into.turns.add(turn));
    else
      want((into) => {
        into.latest = true;
      });
  });

  // While a turn is at work or awaited, a stream that went quiet is not taken at its word: the
  // conversation is read again after a few seconds of silence, then less and less often, and
  // back to listening as soon as the stream speaks. A stream that drops without failing would
  // otherwise leave the turn frozen on screen until it ends.
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let polls = 0;
  const checkQuiet = () => {
    if (streamAt > polledAt) polls = 0;
    const silent = Date.now() - Math.max(streamAt, polledAt);
    if (silent >= Math.min(QUIET_READ_MS * 2 ** polls, QUIET_READ_MAX_MS)) {
      polls += 1;
      polledAt = Date.now();
      void reader.latest();
    }
    quiet = setTimeout(checkQuiet, QUIET_CHECK_MS);
  };

  // Subagents at work are read until none is: their own turns reach this stream only as they
  // start and end, not as they go.
  let crew: ReturnType<typeof setInterval> | undefined;

  // The other agent's work reaches this profile's stream only when it ends, so it is followed
  // here while it runs; its end reads the conversation again, where the answer lands. Keyed by
  // its ids, not by the message, which is a new object on every read.
  let following = '';
  let call: ReturnType<typeof setTimeout> | undefined;
  const followCall = (key: string) => {
    following = key;
    clearTimeout(call);
    if (!key) return;
    const tick = async () => {
      await reader.call();
      if (gone || following !== key) return;
      if (running(store.getState().callRun)) call = setTimeout(tick, FOLLOW_MS);
      else void reader.latest();
    };
    void tick();
  };

  const sync = (state: ConversationState, previous?: ConversationState) => {
    if (working(state) && !quiet) {
      polls = 0;
      quiet = setTimeout(checkQuiet, QUIET_CHECK_MS);
    } else if (!working(state) && quiet) {
      clearTimeout(quiet);
      quiet = undefined;
    }
    if (crewWorking(state) && !crew) crew = setInterval(() => void reader.subagents(), FOLLOW_MS);
    else if (!crewWorking(state) && crew) {
      clearInterval(crew);
      crew = undefined;
    }
    // Only the messages say whether a call is pending, and text under way changes the store
    // several times a second without touching them.
    if (previous && state.messages === previous.messages) return;
    const key = callKey(state);
    if (key !== following) followCall(key);
  };
  sync(store.getState());
  const stopStore = store.subscribe(sync);

  // The gateway back in reach: what was said meanwhile, read at once. Nothing was heard while
  // the stream was down to ask for it.
  const stopOnline = onlineManager.subscribe((online) => {
    if (online) void reader.latest();
  });

  return () => {
    gone = true;
    stopEvents();
    stopStore();
    stopOnline();
    clearTimeout(burst);
    clearTimeout(quiet);
    clearInterval(crew);
    clearTimeout(call);
  };
}
