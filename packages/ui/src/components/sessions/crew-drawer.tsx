'use client';

import { Square } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { HoverTip } from '../../kit/info-tip';
import type { GatewayApi, Message, Profile, ToolStep } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';
import { CodeChanges } from './code-change';
import { active, Elapsed, ModelNames, TierChip, useDrawerFocus } from './crew';
import { barButton, InspectorBar, InspectorBody, InspectorHeader } from './inspector';
import { InspectorContent } from './inspector-host';
import { MessageMedia } from './media';
import { ChatMessage } from './message';
import { LiveTurn, placeSteps, statusOf, traceOf } from './progress';
import { ThoughtLine, WorkMark } from './thought-line';

const chip =
  'inline-flex h-5 shrink-0 items-center rounded-full bg-ink/8 px-2 text-[11px] font-medium whitespace-nowrap text-muted';

/**
 * One agent followed beside the conversation, in the Inspector: its kind and how long it has
 * worked on the top line; its name, tier, model and why it got them above; then what it did and
 * said, which alone scrolls. The chat and the composer stay usable beside it; on a phone it is a
 * sheet from below.
 */
export function CrewDrawer({
  api,
  profileId,
  profile,
}: {
  api: Pick<GatewayApi, 'messages'> & Partial<Pick<GatewayApi, 'media' | 'timeline' | 'cancelRun'>>;
  profileId: string;
  profile?: Pick<Profile, 'name' | 'avatar'>;
}) {
  const following = useCrew((state) => state.following);
  const agent = useCrew((state) => state.agents.find((item) => item.runId === state.following));
  const modelName = useContext(ModelNames);
  const [messages, setMessages] = useState<Message[]>();
  const [steps, setSteps] = useState<ToolStep[]>([]);
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState<string>();
  const closer = useRef<HTMLButtonElement>(null);
  const working = agent ? active(agent) : false;
  const runId = agent?.runId;
  const place = agent?.sessionId;

  useDrawerFocus(agent ? following : undefined, closer);

  useEffect(() => {
    if (!runId || !place) return;
    let stopped = false;
    const read = async () => {
      try {
        const [history, timeline] = await Promise.all([
          api.messages(profileId, place),
          api.timeline?.(profileId, place).catch(() => []) ?? [],
        ]);
        if (stopped) return;
        setMessages(history);
        setSteps(timeline.find((item) => item.runId === runId)?.steps ?? []);
        setError('');
      } catch (failure) {
        if (!stopped) {
          setError(failure instanceof Error ? failure.message : 'Could not load this agent.');
        }
      }
    };
    void read();
    const timer = working ? setInterval(() => void read(), 1500) : undefined;

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, profileId, runId, place, working]);

  if (!agent) return null;
  const failed = !working && agent.status !== 'completed';
  const said = messages?.filter((message) => message.role === 'assistant') ?? [];
  const speaker = profile ?? { name: agent.name, avatar: null };
  const displayed: Message[] = said.length
    ? said
    : !working && agent.output
      ? [
          {
            id: agent.runId,
            profileId,
            sessionId: agent.sessionId,
            runId: agent.runId,
            role: 'assistant',
            content: agent.output,
            createdAt: agent.updatedAt,
          },
        ]
      : [];
  const placement = placeSteps(steps, displayed);
  const activity = (items: ToolStep[]) =>
    items.length > 0 ? (
      <>
        <ThoughtLine working={false} steps={traceOf(items)} />
        <CodeChanges steps={items} fresh />
      </>
    ) : undefined;
  const alreadySaid =
    agent.progress?.phase === 'writing' &&
    said.some((message) => message.content.trim() === agent.progress?.text.trim());

  return (
    <InspectorContent>
      <aside className="crew-drawer" aria-label={agent.name}>
        <InspectorBar
          closer={closer}
          options={
            working &&
            api.cancelRun && (
              <HoverTip tip="Stop agent">
                <button
                  type="button"
                  aria-label="Stop agent"
                  className={`${barButton} disabled:opacity-40`}
                  disabled={stopping === agent.runId}
                  onClick={async () => {
                    const id = agent.runId;
                    setStopping(id);
                    try {
                      const result = await api.cancelRun?.(profileId, id);
                      if (result?.status === 'cancelled') {
                        useCrew.setState((state) => ({
                          agents: state.agents.map((item) =>
                            item.runId === id
                              ? { ...item, status: 'cancelled', updatedAt: result.updatedAt }
                              : item,
                          ),
                        }));
                      }
                    } catch (failure) {
                      toast.error(
                        failure instanceof Error ? failure.message : 'Could not stop this agent.',
                      );
                    } finally {
                      setStopping(undefined);
                    }
                  }}
                >
                  <Square size={13} aria-hidden="true" />
                </button>
              </HoverTip>
            )
          }
        >
          <span className="text-xs">
            {agent.role === 'review' ? 'Review agent' : 'Execute agent'}
          </span>
        </InspectorBar>
        <InspectorHeader title={agent.name}>
          <p className="flex flex-wrap items-center gap-1.5">
            <TierChip tier={agent.tier} />
            {agent.modelSelection && (
              <span className={chip}>{modelName(agent.modelSelection)}</span>
            )}
          </p>
          <p className="flex min-h-5 items-center gap-2 text-xs text-muted" role="status">
            <WorkMark working={working} failed={failed} orb={statusOf(agent).state} />
            <span>
              {stopping === agent.runId
                ? 'Stopping…'
                : working
                  ? 'Working'
                  : agent.status === 'completed'
                    ? 'Completed in'
                    : 'Stopped after'}
            </span>
            <Elapsed agent={agent} className="font-mono text-xs tabular-nums" />
          </p>
        </InspectorHeader>
        <InspectorBody className="grid content-start gap-3 px-5 pt-4 [&_.chat-line]:mb-0">
          {error && <p className="text-[13px] text-bad">{error}</p>}
          {displayed.map((message, index) => (
            <div key={message.id}>
              <ChatMessage
                message={message}
                agent={speaker}
                group={false}
                people={new Map()}
                opensRun
                before={index === 0 ? activity(placement.head) : undefined}
              >
                {api.media && (
                  <MessageMedia
                    api={{ media: api.media }}
                    profileId={profileId}
                    content={message.content}
                  />
                )}
              </ChatMessage>
              {(!working || placement.last?.id !== message.id) &&
                activity(placement.after.get(message.id) ?? [])}
            </div>
          ))}
          {working && !alreadySaid && (
            <LiveTurn
              run={agent}
              agent={speaker}
              steps={placement.last ? (placement.after.get(placement.last.id) ?? []) : steps}
              startedAt={placement.last?.createdAt ?? agent.createdAt}
            />
          )}
          {agent.error && <p className="text-[13px] text-bad">{agent.error}</p>}
        </InspectorBody>
      </aside>
    </InspectorContent>
  );
}
