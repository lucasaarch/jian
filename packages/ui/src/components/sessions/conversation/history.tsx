'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { GatewayApi, Message, Profile, Run } from '../../../lib/api';
import { useCrew } from '../../../lib/stores/crew';
import { useReconnect } from '../../../lib/stores/reconnect';
import { Confetti } from '../confetti';
import { ConversationMap } from '../conversation-map';
import { useFollowBottom } from '../follow-bottom';
import { HistorySkeleton } from '../history-skeleton';
import { running } from '../status';
import { Earlier, useEarlier } from './earlier';
import { mapEntries } from './map-entries';
import { DecidingContext, RowContext, type RowEnv, RowView } from './row';
import { ConversationContext } from './store';
import { ToLatest } from './to-latest';
import { Tray } from './tray';
import { useConversationStore, useLanding, useReader, useRows } from './use-history';

/** No other agents to name: one list for every render, so the rows are not drawn again. */
const NO_AGENTS: Pick<Profile, 'id' | 'name' | 'avatar'>[] = [];

export type HistoryProps = {
  api: Pick<GatewayApi, 'messages' | 'activities'> &
    Partial<
      Pick<
        GatewayApi,
        | 'media'
        | 'people'
        | 'timeline'
        | 'run'
        | 'conversationSubagents'
        | 'answerRun'
        | 'decideApproval'
        | 'react'
      >
    >;
  profileId: string;
  projectId?: string;
  /** The machine the conversation works on, for the Inspector's Changes. */
  machineId?: string;
  onReply?: (message: Message) => void;
  agent?: Pick<Profile, 'name' | 'avatar'>;
  agents?: Pick<Profile, 'id' | 'name' | 'avatar'>[];
  sessionId: string;
  initialRun?: Run;
  /** A change reads the history again at once, as after sending a message. */
  revision?: number;
  empty?: string;
  /** A room: the other side is several people, each shown with their face and name. */
  group?: boolean;
  /**
   * The channel of a chat, by name. Its approvals are decided in the chat, so their cards have no
   * buttons; the agent's questions are the owner's, answered from their card here.
   */
  chat?: string;
  onAnswered?: () => void;
  /** Runs a turn that failed again, where the conversation can be answered from the panel. */
  retryRun?: (run: Run) => Promise<unknown>;
  /**
   * Told the turn at work here whenever that changes, and undefined when none is: what this
   * conversation reads is fresher than any list beside it.
   */
  onWork?: (run: Run | undefined) => void;
};

/**
 * One conversation: its rows over a store of what is known of it, read from the gateway and
 * followed through the event stream while it is on screen.
 */
export function History({
  api,
  agent,
  agents = NO_AGENTS,
  profileId,
  projectId,
  machineId,
  sessionId,
  initialRun,
  revision = 0,
  empty = 'Messages arriving through the channel show up here.',
  group = false,
  chat,
  onAnswered,
  retryRun,
  onReply,
  onWork,
}: HistoryProps) {
  // Asked for from the palette: what is on screen stays while it is read again.
  const reloads = useReconnect((state) => state.chat);
  const store = useConversationStore(profileId, sessionId, initialRun);
  const [retry, setRetry] = useState(0);
  const { reader, opened } = useReader(
    store,
    { api, profileId, sessionId, group },
    { revision, retry, reloads },
  );
  useLanding(store, sessionId);
  const { rows, messages, asks, tools, run, subagents, loading } = useRows(
    store,
    sessionId,
    opened,
  );
  const { error, behind, toolsUnread } = useStore(
    store,
    useShallow(({ error, behind, toolsUnread }) => ({ error, behind, toolsUnread })),
  );
  const { scroller, follow, toEnd, onScroll, hold } = useFollowBottom();
  const { more, earlier, read, near } = useEarlier(store, reader, scroller);

  // Sending is a return to the end, wherever the reader had scrolled.
  useEffect(() => {
    if (revision) follow();
  }, [revision, follow]);

  // The drawer beside the conversation follows these agents from outside the history.
  useEffect(() => {
    useCrew.getState().show(sessionId, subagents, projectId, machineId);
  }, [sessionId, subagents, projectId, machineId]);
  useEffect(() => () => useCrew.getState().leave(sessionId), [sessionId]);
  // Opening or closing the drawer narrows or widens the conversation: the card the owner acted
  // on stays where it was. The store calls back before the layout changes, so the place it
  // holds is the one the owner was looking at.
  useEffect(
    () =>
      useCrew.subscribe((state, previous) => {
        if (state.following !== previous.following) hold(state.opener);
      }),
    [hold],
  );

  const working = running(run) ? run : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: told only when the turn at work changes.
  useEffect(() => onWork?.(working), [working?.id]);

  // Each press settles one thing, then the conversation reads again to show what came of it.
  const [deciding, setDeciding] = useState(false);
  const answered = useRef(onAnswered);
  answered.current = onAnswered;
  const settle = useCallback(
    (work: Promise<unknown> | undefined) => {
      if (!work) return;
      setDeciding(true);
      void work
        .then(() => answered.current?.())
        .catch((failure: unknown) =>
          toast.error(failure instanceof Error ? failure.message : 'That did not go through.'),
        )
        .finally(() => {
          setDeciding(false);
          void reader.current?.latest();
        });
    },
    [reader],
  );

  const replied = useRef(onReply);
  replied.current = onReply;
  const replies = Boolean(onReply);
  const env = useMemo<RowEnv>(
    () => ({
      profileId,
      media: api.media,
      agent,
      agents,
      group,
      chat,
      onReply: replies ? (message) => replied.current?.(message) : undefined,
      react: api.react
        ? async (message, emoji) => {
            const updated = await api.react?.(profileId, sessionId, message.id, emoji);
            if (updated) store.getState().messageChanged(updated);
          }
        : undefined,
      decide: (runId, decision) => settle(api.decideApproval?.(profileId, runId, decision)),
      answer: (runId, choice) => settle(api.answerRun?.(profileId, runId, choice)),
    }),
    [api, profileId, sessionId, agent, agents, group, chat, replies, settle, store],
  );

  const entries = useMemo(() => mapEntries(messages, asks), [messages, asks]);

  return (
    <ConversationContext.Provider value={store}>
      <RowContext.Provider value={env}>
        <DecidingContext.Provider value={deciding}>
          <div className="session-history">
            <p role="status" className="sr-only">
              {loading ? 'Loading conversation…' : ''}
            </p>
            <section
              ref={scroller}
              // Reachable by script alone, to take the focus of the way back to the end.
              tabIndex={-1}
              className="message-history"
              aria-label="Session history"
              aria-busy={loading}
              onScroll={(event) => {
                onScroll(event.currentTarget);
                near(event.currentTarget);
              }}
            >
              <div className="message-list">
                {!loading && more && <Earlier earlier={earlier} onRead={read} />}
                {loading ? (
                  <HistorySkeleton />
                ) : (
                  <>
                    {!messages.length && !error && (
                      <div className="grid justify-items-center gap-1 py-16 text-center">
                        <h3 className="text-sm font-semibold text-ink">
                          No messages in this session
                        </h3>
                        <p className="text-sm">{empty}</p>
                      </div>
                    )}
                    {rows.map((row) => (
                      <RowView key={row.key} row={row} />
                    ))}
                  </>
                )}
              </div>
            </section>
            <ConversationMap scroller={scroller} entries={entries} />
            <ToLatest scroller={scroller} toEnd={toEnd} />
            {/* A chat on WhatsApp or Telegram has no screen there to throw it on. */}
            <Confetti runs={tools} off={Boolean(chat)} />
            <Tray
              loading={loading}
              error={error}
              behind={behind}
              toolsUnread={toolsUnread}
              run={run}
              deciding={deciding}
              retryRun={retryRun}
              onReload={(cover) => {
                if (cover) store.getState().patch({ loading: true });
                setRetry((count) => count + 1);
              }}
              onRetry={(failed) => settle(retryRun?.(failed))}
            />
          </div>
        </DecidingContext.Provider>
      </RowContext.Provider>
    </ConversationContext.Provider>
  );
}
