'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { subscribe } from '@/lib/events';
import { useCrew } from '@/lib/stores/crew';
import type {
  GatewayApi,
  Person,
  Run,
  RunApproval,
  RunQuestion,
  Subagent,
  ToolStep,
} from '../../lib/api';
import { Badge, Button, Empty, Spinner } from '../ui';
import { plainText } from '../ui/markdown';
import { CodeChanges } from './code-change';
import { ConversationMap } from './conversation-map';
import { CrewCards, CrewDock, reportOf } from './crew';
import { ApprovalCard, QuestionCard } from './decision-cards';
import { useFollowBottom } from './follow-bottom';
import { MessageMedia } from './media';
import { authored, ChatMessage } from './message';
import { LiveThought, LiveTurn, traceOf } from './progress';
import { running, statusLabels } from './status';
import { ThoughtLine } from './thought-line';

export function History({
  api,
  profileId,
  sessionId,
  initialRun,
  revision = 0,
  empty = 'Messages arriving through the channel show up here.',
  group = false,
  chat,
  onAnswered,
}: {
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
      >
    >;
  profileId: string;
  sessionId: string;
  initialRun?: Run;
  /** A change reads the history again at once, as after sending a message. */
  revision?: number;
  empty?: string;
  /** A room: the other side is several people, each shown with their face and name. */
  group?: boolean;
  /**
   * The channel a chat's approvals and questions are answered in, by name. Its cards show what
   * is waiting and how it went, without buttons: there, only the chat decides.
   */
  chat?: string;
  onAnswered?: () => void;
}) {
  const [messages, setMessages] = useState<Awaited<ReturnType<GatewayApi['messages']>>>([]);
  const [people, setPeople] = useState(new Map<string, Person>());
  const [tools, setTools] = useState(new Map<string, ToolStep[]>());
  // What each run asked the owner to decide or answer, from the timeline.
  const [asks, setAsks] = useState(
    new Map<string, { approval?: RunApproval; question?: RunQuestion }>(),
  );
  // In an agent conversation this profile started, the other agent's runs and their tools.
  const [callTools, setCallTools] = useState(new Map<string, ToolStep[]>());
  const [callRun, setCallRun] = useState<Run>();
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  // Bumped by an event about this conversation, so it reads again the moment something happens.
  const [heard, setHeard] = useState(0);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const stop = subscribe((event) => {
      if (
        !event.type.startsWith('run.') &&
        !event.type.startsWith('session.') &&
        event.type !== 'conversation.subagent.spawned'
      )
        return;
      const about =
        (event.data as { sessionId?: string; parentSessionId?: string } | undefined)?.sessionId ??
        (event.data as { parentSessionId?: string } | undefined)?.parentSessionId;

      if (about && about !== sessionId) return;
      // Several events arrive together as a turn moves; one read covers them all.
      clearTimeout(timer);
      timer = setTimeout(() => setHeard((value) => value + 1), 150);
    });

    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [sessionId]);
  const [run, setRun] = useState(initialRun);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const isRunning = running(run);
  // The turn being read now: its file changes open whole, older ones only when short.
  const newest = messages.findLast((message) => message.runId)?.runId;
  const { scroller, follow, onScroll, hold } = useFollowBottom();

  // Sending is a return to the end, wherever the reader had scrolled.
  useEffect(() => {
    if (revision) follow();
  }, [revision, follow]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and revision explicitly restart the read.
  useEffect(() => {
    let stopped = false;
    const read = async () => {
      try {
        const [history, activities, members, timeline, children] = await Promise.all([
          api.messages(profileId, sessionId),
          api.activities(profileId),
          group && api.people ? api.people(profileId, sessionId) : [],
          api.timeline ? api.timeline(profileId, sessionId).catch(() => undefined) : undefined,
          api.conversationSubagents?.(profileId, sessionId) ?? [],
        ]);
        // The other agent's tools are read where it worked: its own session, in its profile.
        const places = [
          ...new Map(
            history.flatMap((message) =>
              message.call
                ? [[`${message.call.profileId}/${message.call.sessionId}`, message.call]]
                : [],
            ),
          ).values(),
        ];
        const worked =
          api.timeline && places.length
            ? await Promise.all(
                places.map((call) =>
                  api.timeline?.(call.profileId, call.sessionId).catch(() => undefined),
                ),
              )
            : [];
        if (stopped) return;
        if (worked.every((item) => item !== undefined)) {
          setCallTools(new Map(worked.flat().map((item) => [item.runId, item.steps])));
        }
        if (timeline) {
          setTools(new Map(timeline.map((item) => [item.runId, item.steps])));
          setAsks(
            new Map(
              timeline.flatMap((item) =>
                item.approval || item.question
                  ? [[item.runId, { approval: item.approval, question: item.question }] as const]
                  : [],
              ),
            ),
          );
        }
        setMessages(history);
        setSubagents(children);
        setPeople(new Map(members.map((person) => [person.id, person])));
        setRun(
          activities
            .filter((activity) => activity.sessionId === sessionId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .at(-1),
        );
        setError('');
      } catch (failure) {
        if (!stopped)
          setError(failure instanceof Error ? failure.message : 'The history could not be loaded.');
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    void read();
    return () => {
      stopped = true;
    };
  }, [api, profileId, sessionId, retry, revision, group, heard]);

  // The drawer beside the conversation follows these agents from outside the history.
  useEffect(() => {
    useCrew.getState().show(sessionId, subagents);
  }, [sessionId, subagents]);
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

  useEffect(() => {
    if (!subagents.some((child) => child.status === 'queued' || child.status === 'running')) return;
    const timer = setInterval(() => setHeard((value) => value + 1), 1500);
    return () => clearInterval(timer);
  }, [subagents]);

  // The last question this profile carried to another agent, while its answer has not come back.
  const lastCall = messages
    .filter((message) => message.call && message.role === 'assistant')
    .at(-1)?.call;
  const pendingCall =
    lastCall &&
    !messages.some((message) => message.role === 'user' && message.call?.runId === lastCall.runId)
      ? lastCall
      : undefined;

  // The other agent's work reaches this profile's stream only when it ends, so it is followed
  // here while it runs; its end reads the history again, where the answer lands. Keyed by its
  // ids, not by the object, which is new on every read of the history.
  const callKey = pendingCall
    ? `${pendingCall.profileId} ${pendingCall.sessionId} ${pendingCall.runId}`
    : '';

  useEffect(() => {
    const [callProfile, callSession, callRunId] = callKey.split(' ');
    if (!callProfile || !callSession || !callRunId || !api.run) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const follow = async () => {
      const [current, steps] = await Promise.all([
        api.run?.(callProfile, callRunId).catch(() => undefined),
        api.timeline?.(callProfile, callSession).catch(() => []) ?? [],
      ]);

      if (stopped) return;
      setCallRun(current);
      setCallTools(
        (known) => new Map([...known, ...steps.map((item) => [item.runId, item.steps] as const)]),
      );

      if (running(current)) {
        timer = setTimeout(follow, 1500);
      } else {
        setHeard((value) => value + 1);
      }
    };

    void follow();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, callKey]);

  // Each press settles one thing, then the conversation reads again to show what came of it.
  const settle = (work: Promise<unknown> | undefined) => {
    if (!work) return;
    setDeciding(true);
    void work
      .then(() => onAnswered?.())
      .catch((failure: unknown) =>
        toast.error(failure instanceof Error ? failure.message : 'That did not go through.'),
      )
      .finally(() => {
        setDeciding(false);
        setHeard((value) => value + 1);
      });
  };

  // The owner's own messages, each with the first line of the answer it got, for the map.
  const mapEntries = useMemo(
    () =>
      messages
        .filter((message) => message.role === 'user' && !message.call && !message.purpose)
        .map((message) => {
          const replies = messages.filter(
            (item) => item.role === 'assistant' && item.runId && item.runId === message.runId,
          );
          const asked = message.runId ? asks.get(message.runId) : undefined;
          // A turn that only stopped to ask said nothing yet: its line is the gateway's, drawn
          // as a card, so the map says what it asked instead.
          const first =
            replies.length === 1 && asked?.approval
              ? `Asked for approval: ${asked.approval.title}`
              : replies.length === 1 && asked?.question
                ? `Asked: ${asked.question.prompt}`
                : replies[0]
                  ? plainText(replies[0].content)
                      .split('\n')
                      .find((line) => line.trim())
                  : undefined;

          return {
            id: message.id,
            text: plainText(message.content).replace(/\s+/g, ' ').trim(),
            ...(first ? { reply: first.trim() } : {}),
          };
        })
        .filter((entry) => entry.text),
    [messages, asks],
  );

  return (
    <div className="session-history">
      <section
        ref={scroller}
        className={`message-history ${loading ? 'loading' : ''}`}
        aria-label="Session history"
        aria-busy={loading}
        onScroll={(event) => {
          onScroll(event.currentTarget);
        }}
      >
        <div className="message-list">
          {loading ? (
            <div className="history-loading" role="status" aria-label="Loading conversation">
              <Spinner size={32} />
            </div>
          ) : messages.length ? (
            messages.map((message, index) => {
              const previous = messages[index - 1];
              // Who answers: the agent, or — on a question this profile carried to another
              // agent — that agent, whose run is kept in its own profile.
              const answers = (item: typeof message) =>
                item.call ? item.role === 'user' : item.role === 'assistant';
              const turn = (item: typeof message) => item.call?.runId ?? item.runId;
              // The tools of a turn go above the first thing said in answer to it.
              const opensAnswer =
                answers(message) &&
                !messages
                  .slice(0, index)
                  .some((item) => answers(item) && turn(item) === turn(message));
              const answering = turn(message);
              const steps =
                opensAnswer && answering
                  ? (message.call ? callTools : tools).get(answering)
                  : undefined;
              const unansweredSteps =
                message.role === 'user' &&
                !message.call &&
                message.runId &&
                !(run?.id === message.runId && isRunning) &&
                !messages.some(
                  (item) => item.role === 'assistant' && item.runId === message.runId,
                ) &&
                !messages
                  .slice(index + 1)
                  .some((item) => item.role === 'user' && item.runId === message.runId)
                  ? tools.get(message.runId)
                  : undefined;
              const who = (item: typeof message) =>
                answers(item) ? 'agent' : (authored(item).id ?? authored(item).name ?? '');
              // A turn's time runs from the first message about it to the last one said in it.
              const span = (runId: string) => {
                const about = messages.filter((item) => turn(item) === runId);
                return { startedAt: about[0]?.createdAt, finishedAt: about.at(-1)?.createdAt };
              };
              const live = isRunning && run?.id === message.runId;
              const crew =
                message.runId && !live && messages[index + 1]?.runId !== message.runId
                  ? subagents.filter((child) => child.parentRunId === message.runId)
                  : [];
              const handedOff =
                opensAnswer && answering
                  ? subagents.some((child) => child.parentRunId === answering)
                  : false;

              // A finished agent's report is the agent's mail; its card already says it ended.
              const report = reportOf(message, subagents);
              // The line the gateway writes for an approval or a question becomes its card.
              // A run that stops to ask ends on the line it asked with: its last word is the
              // card, whatever the gateway wrote in it.
              const asked = message.runId ? asks.get(message.runId) : undefined;
              const asking =
                message.role === 'assistant' &&
                !messages
                  .slice(index + 1)
                  .some((later) => later.runId === message.runId && later.role === 'assistant');
              const approval = asking && asked?.approval ? asked.approval : undefined;
              const question = asking && asked?.question ? asked.question : undefined;
              // What the gateway wrote around a pause stays out of the conversation: the note
              // that tells the agent to carry on always, and the reply that answered or
              // decided, which its card already shows.
              const pause =
                message.purpose === 'resume' ||
                (message.purpose === 'answer' && Boolean(asked?.question || asked?.approval));
              // The turn under way heads what it has said with its working line; the live
              // turn below then shows only what is being written.
              const thought =
                live && opensAnswer && run ? (
                  <LiveThought run={run} steps={tools.get(run.id) ?? []} />
                ) : answering && (steps?.length || handedOff) ? (
                  <>
                    <ThoughtLine
                      working={false}
                      steps={traceOf(steps ?? [])}
                      {...span(answering)}
                    />
                    <CodeChanges steps={steps ?? []} fresh={answering === newest} />
                  </>
                ) : undefined;

              return (
                <Fragment key={message.id}>
                  {report || pause ? null : approval && message.runId ? (
                    <div className="chat-line theirs">
                      {thought}
                      <ApprovalCard
                        approval={approval}
                        chat={chat}
                        busy={deciding}
                        onDecide={(decision) =>
                          settle(api.decideApproval?.(profileId, message.runId ?? '', decision))
                        }
                      />
                    </div>
                  ) : question && message.runId ? (
                    <div className="chat-line theirs">
                      {thought}
                      <QuestionCard
                        question={question}
                        chat={chat}
                        busy={deciding}
                        onAnswer={(choice) =>
                          settle(api.answerRun?.(profileId, message.runId ?? '', choice))
                        }
                      />
                    </div>
                  ) : (
                    <ChatMessage
                      message={message}
                      group={group}
                      people={people}
                      opensRun={!previous || who(previous) !== who(message)}
                      before={thought}
                    >
                      {api.media && (
                        <MessageMedia
                          api={{ media: api.media }}
                          profileId={profileId}
                          content={message.content}
                        />
                      )}
                    </ChatMessage>
                  )}
                  {unansweredSteps && message.runId && (
                    <div className="chat-line theirs">
                      <ThoughtLine
                        working={false}
                        steps={traceOf(unansweredSteps)}
                        {...span(message.runId)}
                      />
                      <CodeChanges steps={unansweredSteps} fresh={message.runId === newest} />
                    </div>
                  )}
                  {crew.length > 0 && (
                    <div className="chat-line theirs">
                      <CrewCards agents={crew} />
                    </div>
                  )}
                </Fragment>
              );
            })
          ) : (
            !error && <Empty title="No messages in this session">{empty}</Empty>
          )}
          {!loading && pendingCall && callRun && running(callRun) && (
            <LiveTurn run={callRun} steps={callTools.get(callRun.id) ?? []} />
          )}
          {!loading && run && isRunning && (
            <LiveTurn
              run={run}
              steps={tools.get(run.id) ?? []}
              lined={messages.some(
                (item) => item.runId === run.id && item.role === 'assistant' && !item.call,
              )}
            >
              <CrewCards agents={subagents.filter((child) => child.parentRunId === run.id)} />
            </LiveTurn>
          )}
        </div>
      </section>
      <ConversationMap scroller={scroller} entries={mapEntries} />
      {/* What sits just above the composer: errors, a question waiting, agents at work. It
          floats with the composer over the end of the conversation. */}
      <div className="history-tray">
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
        <CrewDock agents={subagents} />
      </div>
    </div>
  );
}
