'use client';

import { createContext, memo, type ReactNode, useContext, useState } from 'react';
import type { GatewayApi, Message, Person, Profile, ToolStep } from '../../../lib/api';
import { useCrew } from '../../../lib/stores/crew';
import { CrewCards } from '../crew';
import { ApprovalCard, QuestionCard } from '../decision-cards';
import { MessageMedia } from '../media';
import { authored, cleanText, mine, PersonLine } from '../message';
import { MessageActions, MessageReactions } from '../message-actions';
import { OutgoingState, sentMessage } from '../outgoing';
import { AgentLine } from './agent-line';
import { LiveAnswer, LiveWork } from './live-answer';
import { spentOf } from './live-text';
import { type Row, type Span, sameRow } from './rows';
import { useConversation } from './store';
import { answers, turnOf } from './turns';
import { RunChangesSummary, Worked } from './work';

/** What every row draws with that is not the row itself: the same for the whole conversation. */
export type RowEnv = {
  profileId: string;
  media?: GatewayApi['media'];
  agent?: Pick<Profile, 'name' | 'avatar'>;
  agents: Pick<Profile, 'id' | 'name' | 'avatar'>[];
  group: boolean;
  chat?: string;
  onReply?: (message: Message) => void;
  react?: (message: Message, emoji: string | null) => Promise<void>;
  decide: (runId: string, decision: 'approve' | 'reject') => void;
  answer: (runId: string, choice: string) => void;
};

export const RowContext = createContext<RowEnv | null>(null);
/** An answer or a decision is on its way: every card waits. Read by the cards alone. */
export const DecidingContext = createContext(false);

/** Who wrote a line, to tell where a run of lines from one writer begins. */
const who = (message: Message) =>
  answers(message) ? 'agent' : (authored(message).id ?? authored(message).name ?? '');

type Asking = Extract<Row, { kind: 'approval' | 'question' }>;

function Asked({ row, env }: { row: Asking; env: RowEnv }) {
  const busy = useContext(DecidingContext);
  return row.kind === 'approval' ? (
    <ApprovalCard
      approval={row.approval}
      chat={env.chat}
      busy={busy}
      onDecide={(decision) => env.decide(row.runId, decision)}
    />
  ) : (
    <QuestionCard
      question={row.question}
      chat={env.chat}
      busy={busy}
      onAnswer={(choice) => env.answer(row.runId, choice)}
    />
  );
}

/** The tools a turn used before the line a row draws. */
const headOf = (row: { head?: ToolStep[]; headSpan?: Span }, runId: string | undefined) =>
  row.head?.length ? (
    <Worked
      steps={row.head}
      runId={runId}
      startedAt={row.headSpan?.startedAt}
      finishedAt={row.headSpan?.finishedAt}
    />
  ) : undefined;

/**
 * A row as two slots: a line of work above it, and the line itself. Plain functions, not
 * components: the key that moves from one kind to another must find the same component types
 * in the same slots, or React draws its element anew.
 */
function draw(
  row: Row,
  env: RowEnv,
  people: Map<string, Person>,
  caller: string | undefined,
): [ReactNode, ReactNode] {
  switch (row.kind) {
    case 'message':
      return drawMessage(row, env, people);
    case 'approval':
    case 'question':
      return [
        null,
        <div className="chat-line theirs" key="line">
          {headOf(row, row.runId)}
          <CrewCards agents={row.crewBefore} />
          <Asked row={row} env={env} />
        </div>,
      ];
    case 'work':
      return [
        null,
        <div className="chat-line theirs work" key="line">
          <Worked
            steps={row.steps}
            runId={row.runId}
            startedAt={row.startedAt}
            finishedAt={row.finishedAt}
          />
        </div>,
      ];
    case 'changes':
      return [
        null,
        <RunChangesSummary
          key="line"
          steps={row.steps}
          onOpen={(step, opener) =>
            useCrew.getState().showChanges({
              runId: row.runId,
              toolCallId: step.toolCallId,
              path: step.diff.path,
              opener,
            })
          }
        />,
      ];
    case 'crew':
      return [
        null,
        <div className="chat-line theirs" key="line">
          <CrewCards agents={row.agents} />
        </div>,
      ];
    case 'outgoing': {
      const message = sentMessage(row.item, env.profileId);
      return [
        null,
        <PersonLine
          key="line"
          message={message}
          group={env.group}
          people={people}
          opensRun={false}
          outgoing={row.item.state}
        >
          {env.media && row.item.mediaIds.length > 0 ? (
            <MessageMedia
              api={{ media: env.media }}
              profileId={env.profileId}
              content={message.content}
            />
          ) : null}
          <OutgoingState item={row.item} />
        </PersonLine>,
      ];
    }
    case 'live': {
      const agent = row.side === 'call' ? env.agents.find((item) => item.id === caller) : env.agent;
      return [
        null,
        <AgentLine
          key="line"
          agent={agent}
          pending
          before={
            <>
              <LiveWork
                runId={row.runId}
                side={row.side}
                status={row.status}
                createdAt={row.createdAt}
                steps={row.steps}
                startedAt={row.startedAt}
              />
              <CrewCards agents={row.crew} />
            </>
          }
          text={<LiveAnswer runId={row.runId} side={row.side} />}
        />,
      ];
    }
  }
}

function drawMessage(
  row: Extract<Row, { kind: 'message' }>,
  env: RowEnv,
  people: Map<string, Person>,
): [ReactNode, ReactNode] {
  const { message, previous } = row;
  const thought = headOf(row, turnOf(message));
  // A line sent while the turn was at work: what the turn did before it stays above it.
  const above =
    row.steered && thought ? (
      <div className="chat-line theirs work" key="head">
        {thought}
      </div>
    ) : null;
  const media = env.media ? (
    <MessageMedia
      api={{ media: env.media }}
      profileId={env.profileId}
      content={message.content}
      drawn={row.drawn}
    />
  ) : null;
  const agent =
    message.call && message.role === 'user'
      ? env.agents.find((item) => item.id === message.call?.profileId)
      : env.agent;

  if (mine(message)) {
    return [
      above,
      <PersonLine
        key="line"
        message={message}
        group={env.group}
        people={people}
        opensRun={!previous || who(previous) !== who(message)}
        agent={agent}
      >
        {media}
        {null}
      </PersonLine>,
    ];
  }
  const { onReply, react } = env;

  return [
    above,
    <AgentLine
      key="line"
      agent={agent}
      messageId={message.id}
      actions={
        message.role === 'assistant' && !message.call ? (
          <MessageActions
            message={message}
            onReply={onReply ? () => onReply(message) : undefined}
            onReact={react ? (emoji) => react(message, emoji) : undefined}
          />
        ) : null
      }
      before={
        <>
          {row.steered ? null : thought}
          <CrewCards agents={row.crewBefore} />
        </>
      }
      text={
        <LiveAnswer
          said={cleanText(message.content)}
          runId={row.liveTail ? row.lastMessage.runId : undefined}
        />
      }
      reactions={<MessageReactions message={message} agentName={agent?.name} />}
    >
      {media}
    </AgentLine>,
  ];
}

function HistoryRow({ row }: { row: Row }) {
  const env = useContext(RowContext);
  if (!env) throw new Error('A history row needs a RowContext around it.');
  // Read once, as the row first draws: the next build marks it seen, which must not end the
  // animation it started.
  const [fresh] = useState('fresh' in row && row.fresh);
  const people = useConversation((state) => state.people);
  const spent = useConversation(
    (state) => row.kind === 'live' && spentOf(state, row.runId, row.side),
  );
  const caller = useConversation((state) =>
    row.kind === 'live' && row.side === 'call' ? state.callRun?.profileId : undefined,
  );
  const [above, line] = spent ? [null, null] : draw(row, env, people, caller);

  return (
    <div className="history-row" data-fresh={fresh || undefined} hidden={spent || undefined}>
      {above}
      {line}
    </div>
  );
}

/** One row of the conversation, drawn again only when what it shows changed. */
export const RowView = memo(HistoryRow, (a, b) => sameRow(a.row, b.row));
