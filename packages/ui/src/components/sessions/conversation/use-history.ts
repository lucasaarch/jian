'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { Run } from '../../../lib/api';
import { forgetLanded, landed, useOutbox } from '../../../lib/stores/outbox';
import { useKeptHistory } from '../kept-history';
import { running } from '../status';
import { followConversation } from './events';
import { writtenOf } from './live-text';
import { createReader, type HistoryApi, type Reader } from './reader';
import { buildRows, type Row } from './rows';
import { type ConversationState, type ConversationStore, createConversationStore } from './store';

/** What a reopened conversation shows: a change to any of these is kept. */
const KEPT = ['messages', 'tools', 'asks', 'callTools', 'subagents', 'people', 'run'] as const;

/**
 * The store of the conversation on screen, opened from what was kept of it and the turn the
 * list beside it knows, and kept again after every read that changed what it would show.
 */
export function useConversationStore(profileId: string, sessionId: string, initialRun?: Run) {
  const { kept, keep } = useKeptHistory(profileId, sessionId);
  const place = `${profileId}/${sessionId}`;
  const open = () => {
    const store = createConversationStore(kept);
    if (initialRun) store.getState().runRead(initialRun);
    return { place, store };
  };
  const [held, setHeld] = useState(open);
  // Another conversation in the same view starts from what is known of it, never from this one.
  if (held.place !== place) setHeld(open());
  const { store } = held;

  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (state.loading || !KEPT.some((field) => state[field] !== previous[field])) return;
        keep(state.snapshot());
      }),
    [store, keep],
  );

  return store;
}

/**
 * The reader of the conversation and the stream it follows, for as long as it is on screen.
 * The first read starts with it; a change of `revision`, `retry` or `reloads` reads again.
 * `opened` turns on once that first read is over, whatever it found: until then, everything it
 * brings is part of opening the conversation, not news.
 */
export function useReader(
  store: ConversationStore,
  source: { api: HistoryApi; profileId: string; sessionId: string; group: boolean },
  asked: { revision: number; retry: number; reloads: number },
) {
  const { api, profileId, sessionId, group } = source;
  const { revision, retry, reloads } = asked;
  // Read by the reader at each read: a reload the owner asked for starts over from the gateway.
  const reloaded = useRef(reloads);
  reloaded.current = reloads;
  const reader = useRef<Reader>(undefined);
  // The store whose first read is over. Kept by store, not as a flag, so a conversation that
  // replaces this one in the same view counts as opening again from its very first render.
  const [read, setRead] = useState<ConversationStore>();

  useEffect(() => {
    const read = createReader({
      api,
      profileId,
      sessionId,
      group,
      store,
      reloads: () => reloaded.current,
    });
    reader.current = read;
    const unfollow = followConversation({ store, reader: read, sessionId });
    let gone = false;
    void read.latest().then(() => {
      if (!gone) setRead(store);
    });
    return () => {
      gone = true;
      unfollow();
      read.stop();
    };
  }, [api, profileId, sessionId, group, store]);

  const last = useRef(asked);
  useEffect(() => {
    const was = last.current;
    last.current = { revision, retry, reloads };
    if (was.revision !== revision || was.retry !== retry || was.reloads !== reloads) {
      void reader.current?.latest();
    }
  }, [revision, retry, reloads]);

  return { reader, opened: read === store };
}

/**
 * What the owner sent from here, followed until the conversation holds it. A stored message
 * takes the outbox key in the same change that brings it, before the outbox lets it go, so the
 * line drawn as it was sent is the element that stays. A turn the gateway took is awaited, so
 * the agent is drawn starting until a read says more.
 */
export function useLanding(store: ConversationStore, sessionId: string) {
  useEffect(() => {
    const land = () => {
      const { messages, sent } = store.getState();
      const gone: string[] = [];
      for (const item of useOutbox.getState().items) {
        if (item.sessionId !== sessionId) continue;
        const message = messages.find((known) => landed(item, [known]));
        if (!message) continue;
        sent(message.id, item.key);
        gone.push(item.key);
      }
      forgetLanded(gone);
    };
    land();
    const stopStore = store.subscribe((state, previous) => {
      if (state.messages !== previous.messages) land();
    });
    const stopOutbox = useOutbox.subscribe(land);
    return () => {
      stopStore();
      stopOutbox();
    };
  }, [store, sessionId]);

  // Timed from when the gateway was seen to take each turn, not from the click: a read that
  // began in between may not hold the turn yet. Each turn is awaited once: one a read already
  // accounted for is not awaited again when the outbox changes for another message.
  const outbox = useOutbox((state) => state.items);
  const taken = useRef(new Set<string>());
  useEffect(() => {
    const fresh = outbox.flatMap((item) =>
      item.sessionId === sessionId &&
      item.state === 'sent' &&
      item.runId &&
      !taken.current.has(item.runId)
        ? [item.runId]
        : [],
    );
    if (!fresh.length) return;
    const at = new Date().toISOString();
    for (const runId of fresh) taken.current.add(runId);
    const { awaited, patch } = store.getState();
    patch({ awaited: new Map([...awaited, ...fresh.map((runId) => [runId, at] as const)]) });
  }, [outbox, sessionId, store]);
}

const pick = (state: ConversationState) => ({
  messages: state.messages,
  tools: state.tools,
  asks: state.asks,
  callTools: state.callTools,
  run: state.run,
  callRun: state.callRun,
  subagents: state.subagents,
  keys: state.keys,
  liveSerial: state.liveSerial,
  awaited: state.awaited,
  loading: state.loading,
});

/**
 * Whether the turn at work shows text, under way or held for its message, never the text, so
 * text builds no rows.
 */
const writingOf = (state: ConversationState) =>
  running(state.run) && Boolean(writtenOf(state, state.run?.id, 'self'));

const still = (row: Row): Row => ('fresh' in row && row.fresh ? { ...row, fresh: false } : row);

/**
 * The rows to draw, built again only when what they show changed. A row is fresh only when it is
 * new to the conversation: nothing animates as it opens, kept or read, and an earlier page is
 * not new. `opened` says the first read is over.
 */
export function useRows(store: ConversationStore, sessionId: string, opened: boolean) {
  const state = useStore(store, useShallow(pick));
  const writing = useStore(store, writingOf);
  const outgoing = useOutbox((outbox) => outbox.items);
  const seen = useRef(new Set<string>());
  const oldest = useRef<string>(undefined);
  // Another conversation in the same view opens as this one did, with nothing seen yet.
  const owner = useRef(store);
  if (owner.current !== store) {
    owner.current = store;
    seen.current = new Set();
    oldest.current = undefined;
  }

  const rows = useMemo(() => {
    const { messages } = state;
    const from = oldest.current
      ? messages.findIndex((message) => message.id === oldest.current)
      : 0;
    for (const message of messages.slice(0, Math.max(from, 0))) {
      for (const key of [message.id, `approval:${message.id}`, `question:${message.id}`]) {
        seen.current.add(key);
      }
    }
    const built = buildRows({ ...state, outgoing, sessionId, seen: seen.current, writing });
    return opened ? built : built.map(still);
  }, [state, outgoing, sessionId, writing, opened]);

  useEffect(() => {
    if (state.loading) return;
    oldest.current = state.messages[0]?.id;
    for (const row of rows) seen.current.add(row.key);
  }, [rows, state]);

  return { rows, ...state };
}
