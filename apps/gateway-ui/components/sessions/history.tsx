'use client';

import { LoaderCircle } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GatewayApi, Person, Run, ToolStep } from '../../lib/api';
import { useWorkspace } from '../../lib/workspace';
import { Badge, Button, Empty } from '../ui';
import { MessageMedia } from './media';
import { authored, ChatMessage } from './message';
import { RunProgress } from './progress';
import { running, statusLabels } from './status';
import { ToolTimeline } from './timeline';

export function History({
  api,
  profileId,
  sessionId,
  initialRun,
  revision = 0,
  empty = 'Messages arriving through the channel show up here.',
  group = false,
}: {
  api: Pick<GatewayApi, 'messages' | 'activities'> &
    Partial<Pick<GatewayApi, 'media' | 'people' | 'timeline'>>;
  profileId: string;
  sessionId: string;
  initialRun?: Run;
  /** A change reads the history again at once, as after sending a message. */
  revision?: number;
  empty?: string;
  /** A room: the other side is several people, each shown with their face and name. */
  group?: boolean;
}) {
  const [messages, setMessages] = useState<Awaited<ReturnType<GatewayApi['messages']>>>([]);
  const [people, setPeople] = useState(new Map<string, Person>());
  const [tools, setTools] = useState(new Map<string, ToolStep[]>());
  // Bumped by an event about this conversation, so it reads again the moment something happens.
  const [heard, setHeard] = useState(0);
  const { subscribe } = useWorkspace();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const stop = subscribe((event) => {
      if (!event.type.startsWith('run.') && !event.type.startsWith('session.')) return;
      const about = (event.data as { sessionId?: string } | undefined)?.sessionId;

      if (about && about !== sessionId) return;
      // Several events arrive together as a turn moves; one read covers them all.
      clearTimeout(timer);
      timer = setTimeout(() => setHeard((value) => value + 1), 150);
    });

    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [subscribe, sessionId]);
  const [run, setRun] = useState(initialRun);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const isRunning = running(run);
  const scroller = useRef<HTMLElement>(null);
  // Whether the reader is at the end: a chat opens there and follows new messages, but leaves
  // alone someone who scrolled up to read.
  const following = useRef(true);

  // Sending is a return to the end, wherever the reader had scrolled.
  useEffect(() => {
    if (revision) following.current = true;
  }, [revision]);

  // Attachments load after their message and grow it, so the end is followed by size, not by
  // what arrived.
  useLayoutEffect(() => {
    const element = scroller.current;
    const content = element?.firstElementChild;

    if (!element || !content) return;
    const follow = () => {
      if (following.current) element.scrollTop = element.scrollHeight;
    };
    const observer = new ResizeObserver(follow);

    follow();
    observer.observe(content);

    return () => observer.disconnect();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and revision explicitly restart the read.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [history, activities, members, timeline] = await Promise.all([
          api.messages(profileId, sessionId),
          api.activities(profileId),
          group && api.people ? api.people(profileId, sessionId) : [],
          api.timeline ? api.timeline(profileId, sessionId).catch(() => []) : [],
        ]);
        if (stopped) return;
        setTools(new Map(timeline.map((item) => [item.runId, item.steps])));
        setMessages(history);
        setPeople(new Map(members.map((person) => [person.id, person])));
        setRun(
          activities
            .filter((activity) => activity.sessionId === sessionId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .at(-1),
        );
        setError('');
        // The stream says when to read; this only covers an event lost while it reconnected.
        timer = setTimeout(poll, isRunning ? 10_000 : 30_000);
      } catch (failure) {
        if (!stopped)
          setError(failure instanceof Error ? failure.message : 'The history could not be loaded.');
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, profileId, sessionId, isRunning, retry, revision, group, heard]);

  return (
    <div className="session-history">
      <section
        ref={scroller}
        className="message-history"
        aria-label="Session history"
        aria-busy={loading}
        onScroll={(event) => {
          const element = event.currentTarget;

          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        <div className="message-list">
          {loading ? (
            <div className="history-loading" role="status">
              <LoaderCircle size={20} className="spin" />
              Loading the history…
            </div>
          ) : messages.length ? (
            messages.map((message, index) => {
              const previous = messages[index - 1];
              // The tools of a turn go above the first thing the agent said in it.
              const opensAnswer =
                message.role === 'assistant' &&
                !messages
                  .slice(0, index)
                  .some((item) => item.role === 'assistant' && item.runId === message.runId);
              const steps = opensAnswer && message.runId ? tools.get(message.runId) : undefined;
              const who = (item: typeof message) =>
                item.role === 'assistant'
                  ? 'agent'
                  : (authored(item).id ?? authored(item).name ?? '');

              return (
                <ChatMessage
                  key={message.id}
                  message={message}
                  group={group}
                  people={people}
                  opensRun={!previous || who(previous) !== who(message)}
                  before={steps && <ToolTimeline steps={steps} />}
                >
                  {api.media && (
                    <MessageMedia
                      api={{ media: api.media }}
                      profileId={profileId}
                      content={message.content}
                    />
                  )}
                </ChatMessage>
              );
            })
          ) : (
            !error && <Empty title="No messages in this session">{empty}</Empty>
          )}
          {run && isRunning && (
            <RunProgress
              run={run}
              toolShown={Boolean(tools.get(run.id)?.some((step) => step.status === 'running'))}
            >
              <ToolTimeline steps={tools.get(run.id) ?? []} live />
            </RunProgress>
          )}
        </div>
      </section>
      {error && (
        <div className="history-error" role="alert">
          <p>{error}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setLoading(true);
              setRetry((value) => value + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {/* The dots already say the agent is working; the bar speaks only when a turn went wrong. */}
      {run && ['failed', 'interrupted', 'cancelled'].includes(run.status) && (
        <div className="run-status">
          <Badge tone={run.status === 'cancelled' ? 'neutral' : 'bad'}>
            {statusLabels[run.status]}
          </Badge>
          {run.error && <p className="text-bad">{run.error}</p>}
        </div>
      )}
    </div>
  );
}
