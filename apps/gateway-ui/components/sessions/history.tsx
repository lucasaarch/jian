'use client';

import { LoaderCircle, LockKeyhole } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GatewayApi, Run } from '../../lib/api';
import { date } from '../../lib/format';
import { Badge, Button, Empty } from '../ui';
import { MessageMedia } from './media';
import { RunProgress } from './progress';
import { running, statusLabels } from './status';

export function History({
  api,
  profileId,
  sessionId,
  initialRun,
}: {
  api: Pick<GatewayApi, 'messages' | 'activities'> & Partial<Pick<GatewayApi, 'media'>>;
  profileId: string;
  sessionId: string;
  initialRun?: Run;
}) {
  const [messages, setMessages] = useState<Awaited<ReturnType<GatewayApi['messages']>>>([]);
  const [run, setRun] = useState(initialRun);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const isRunning = running(run);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly restarts a failed read.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [history, activities] = await Promise.all([
          api.messages(profileId, sessionId),
          api.activities(profileId),
        ]);
        if (stopped) return;
        setMessages(history);
        setRun(
          activities
            .filter((activity) => activity.sessionId === sessionId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .at(-1),
        );
        setError('');
        timer = setTimeout(poll, isRunning ? 3000 : 10000);
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
  }, [api, profileId, sessionId, isRunning, retry]);

  return (
    <div className="session-history">
      <div className="history-caption">
        <LockKeyhole size={14} />
        <span>Read only</span>
        <span>{messages.length === 1 ? '1 message' : `${messages.length} messages`}</span>
      </div>
      <section className="message-history" aria-label="Session history" aria-busy={loading}>
        {loading ? (
          <div className="history-loading" role="status">
            <LoaderCircle size={20} className="spin" />
            Loading the history…
          </div>
        ) : messages.length ? (
          messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <header>
                <strong>
                  {message.role === 'user'
                    ? 'User'
                    : message.role === 'assistant'
                      ? 'Agent'
                      : message.role === 'system'
                        ? 'System'
                        : 'Tool'}
                </strong>
                <time dateTime={message.createdAt}>{date(message.createdAt)}</time>
              </header>
              <p>{message.content.replace(/\[Attached media: [0-9a-f-]{36}\]/g, '').trim()}</p>
              {api.media && (
                <MessageMedia
                  api={{ media: api.media }}
                  profileId={profileId}
                  content={message.content}
                />
              )}
            </article>
          ))
        ) : (
          !error && (
            <Empty title="No messages in this session">
              Messages arriving through the channel show up here.
            </Empty>
          )
        )}
        {run && isRunning && <RunProgress run={run} />}
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
      {run && (
        <div className="run-status">
          <Badge
            tone={
              run.status === 'completed'
                ? 'good'
                : ['failed', 'interrupted'].includes(run.status)
                  ? 'bad'
                  : 'neutral'
            }
          >
            {statusLabels[run.status]}
          </Badge>
          {run.usage && (
            <small>
              {(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()} tokens ·{' '}
              {run.usage.steps === 1 ? '1 step' : `${run.usage.steps} steps`}
            </small>
          )}
          {run.error && <p className="text-bad">{run.error}</p>}
        </div>
      )}
    </div>
  );
}
