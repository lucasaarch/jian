'use client';

import { useContext, useEffect, useRef, useState } from 'react';
import type { GatewayApi, Message, ToolStep } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';
import { CodeChanges } from './code-change';
import { active, Elapsed, ModelNames, nowOf, TierChip, tierNames, useDrawerFocus } from './crew';
import { InspectorBar, InspectorBody, InspectorHeader } from './inspector';
import { MessageMedia } from './media';
import { ChatMessage } from './message';
import { statusOf, traceOf } from './progress';
import { ThoughtLine, WorkMark } from './thought-line';

const reasons = {
  agent: (tier: string) => `Chosen by the agent: ${tier}`,
  jev: (tier: string) => `Jev picked ${tier}`,
  default: (tier: string) => `${tier} by default`,
};

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
}: {
  api: Pick<GatewayApi, 'messages'> & Partial<Pick<GatewayApi, 'media' | 'timeline'>>;
  profileId: string;
}) {
  const following = useCrew((state) => state.following);
  const agent = useCrew((state) => state.agents.find((item) => item.runId === state.following));
  const modelName = useContext(ModelNames);
  const [messages, setMessages] = useState<Message[]>();
  const [steps, setSteps] = useState<ToolStep[]>([]);
  const [error, setError] = useState('');
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
  const tier = agent.tier ? tierNames[agent.tier] : undefined;
  const failed = !working && agent.status !== 'completed';
  const said = messages?.filter((message) => message.role === 'assistant') ?? [];

  return (
    <aside className="crew-drawer" aria-label={agent.name}>
      <InspectorBar closer={closer}>
        <WorkMark working={working} failed={failed} orb={statusOf(agent).state} />
        <span className="text-xs">
          {agent.role === 'review' ? 'Review agent' : 'Execute agent'}
        </span>
        <span aria-hidden="true" className="text-xs">
          ·
        </span>
        <Elapsed agent={agent} className="font-mono text-xs tabular-nums" />
      </InspectorBar>
      <InspectorHeader title={agent.name}>
        <p className="flex flex-wrap items-center gap-1.5">
          <TierChip tier={agent.tier} />
          {agent.modelSelection && <span className={chip}>{modelName(agent.modelSelection)}</span>}
        </p>
        {tier && agent.tierBy && (
          <p className="text-xs text-muted">{reasons[agent.tierBy](tier)}</p>
        )}
      </InspectorHeader>
      <InspectorBody className="grid content-start gap-3 px-5 pt-4 [&_.chat-line]:mb-0">
        <ThoughtLine
          working={working}
          label={nowOf(agent)}
          doneLabel={agent.status === 'completed' ? 'Finished in' : 'Stopped after'}
          failed={failed}
          orb={statusOf(agent).state}
          steps={traceOf(steps)}
          startedAt={agent.createdAt}
          finishedAt={working ? undefined : agent.updatedAt}
        />
        <CodeChanges steps={steps} fresh />
        {error && <p className="text-[13px] text-bad">{error}</p>}
        {said.map((message) => (
          <ChatMessage key={message.id} message={message} group={false} people={new Map()} opensRun>
            {api.media && (
              <MessageMedia
                api={{ media: api.media }}
                profileId={profileId}
                content={message.content}
              />
            )}
          </ChatMessage>
        ))}
        {!said.length && agent.output && (
          <p className="text-sm whitespace-pre-wrap">{agent.output}</p>
        )}
        {agent.error && <p className="text-[13px] text-bad">{agent.error}</p>}
      </InspectorBody>
    </aside>
  );
}
