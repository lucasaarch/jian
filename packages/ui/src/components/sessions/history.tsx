'use client';

import { onlineManager } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  GatewayApi,
  Message,
  Person,
  Run,
  RunApproval,
  RunQuestion,
  Subagent,
  ToolStep,
} from '../../lib/api';
import { subscribe } from '../../lib/events';
import { useCrew } from '../../lib/stores/crew';
import { plainText } from '../ui/markdown';
import { CodeChanges } from './code-change';
import { Confetti } from './confetti';
import { ConversationMap } from './conversation-map';
import { CrewCards, CrewDock, reportOf } from './crew';
import { ApprovalCard, QuestionCard } from './decision-cards';
import { useFollowBottom } from './follow-bottom';
import { HistorySkeleton } from './history-skeleton';
import { useKeptHistory } from './kept-history';
import { MessageMedia } from './media';
import { authored, ChatMessage } from './message';
import { LiveTurn, placeSteps, traceOf } from './progress';
import { running } from './status';
import { ThoughtLine } from './thought-line';
import { TroubleCard } from './trouble';

/**
 * Who answers a message: the agent, or — on a question this profile carried to another agent —
 * that agent, whose run is kept in its own profile.
 */
const answers = (message: Message) =>
  message.call ? message.role === 'user' : message.role === 'assistant';
const turnOf = (message: Message) => message.call?.runId ?? message.runId;
/** When a stretch of tools ended: its last tool's end, so a settled line stops its clock there. */
const endOf = (steps: ToolStep[]) =>
  steps
    .map((step) => step.finishedAt ?? step.startedAt)
    .sort()
    .at(-1);

/** Tools a turn used between two things it said, settled, with the files they changed. */
function Worked({
  steps,
  startedAt,
  finishedAt = endOf(steps),
  fresh,
}: {
  steps: ToolStep[];
  startedAt?: string;
  finishedAt?: string;
  fresh: boolean;
}) {
  return (
    <>
      <ThoughtLine
        working={false}
        steps={traceOf(steps)}
        startedAt={startedAt}
        finishedAt={finishedAt}
      />
      <CodeChanges steps={steps} fresh={fresh} />
    </>
  );
}

/** What a turn that went wrong is called, and what is said when the gateway kept no reason. */
const troubles = {
  failed: 'Agent encountered an error',
  interrupted: 'The agent was interrupted',
  cancelled: 'The run was cancelled',
} as const;
const fallbacks = {
  failed: 'This run hit an unexpected error.',
  interrupted: 'It stopped before it finished.',
  cancelled: 'It stopped before it finished.',
} as const;

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
  retryRun,
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
  /** Runs a turn that failed again, where the conversation can be answered from the panel. */
  retryRun?: (run: Run) => Promise<unknown>;
}) {
  // Read before: shown at once, and read again behind it.
  const { kept, keep } = useKeptHistory(profileId, sessionId);
  const [messages, setMessages] = useState<Awaited<ReturnType<GatewayApi['messages']>>>(
    kept?.messages ?? [],
  );
  const [people, setPeople] = useState(
    new Map<string, Person>(kept?.people.map((person) => [person.id, person])),
  );
  const [tools, setTools] = useState(new Map<string, ToolStep[]>(kept?.tools));
  // What each run asked the owner to decide or answer, from the timeline.
  const [asks, setAsks] = useState(
    new Map<string, { approval?: RunApproval; question?: RunQuestion }>(kept?.asks),
  );
  // In an agent conversation this profile started, the other agent's runs and their tools.
  const [callTools, setCallTools] = useState(new Map<string, ToolStep[]>(kept?.callTools));
  const [callRun, setCallRun] = useState<Run>();
  const [subagents, setSubagents] = useState<Subagent[]>(kept?.subagents ?? []);
  // Something is on screen: a failed read leaves it there rather than covering it with an error.
  const shown = useRef(Boolean(kept));
  // Bumped by an event about this conversation, so it reads again the moment something happens.
  const [heard, setHeard] = useState(0);
  const [deciding, setDeciding] = useState(false);
  // The failed turn whose card the owner closed; a later one shows its own.
  const [dismissed, setDismissed] = useState<string>();

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
  const [run, setRun] = useState(initialRun ?? kept?.run);
  const [loading, setLoading] = useState(!kept);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const isRunning = running(run);
  // The turn being read now: its file changes open whole, older ones only when short.
  const newest = messages.findLast((message) => message.runId)?.runId;
  // Each turn's tools among the lines it said, so the work shows up as it was spoken.
  const placed = useMemo(() => {
    const said = new Map<string, { lines: Message[]; call: boolean }>();

    for (const message of messages) {
      const turn = turnOf(message);
      if (!turn || !answers(message)) continue;
      const known = said.get(turn) ?? { lines: [], call: Boolean(message.call) };
      known.lines.push(message);
      said.set(turn, known);
    }

    return new Map(
      [...said].map(([turn, { lines, call }]) => [
        turn,
        placeSteps((call ? callTools : tools).get(turn) ?? [], lines),
      ]),
    );
  }, [messages, tools, callTools]);
  // A turn under way keeps the tools since its last line for its working line at the end.
  const trailing = (live: Run, known: Map<string, ToolStep[]>) => {
    const place = placed.get(live.id);

    return place?.last
      ? { steps: place.after.get(place.last.id) ?? [], startedAt: place.last.createdAt }
      : { steps: known.get(live.id) ?? [], startedAt: live.createdAt };
  };

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
        // What a part that could not be read leaves as it was.
        const nextCallTools = worked.every((item) => item !== undefined)
          ? worked.flat().map((item): [string, ToolStep[]] => [item.runId, item.steps])
          : [...callTools];
        const nextTools = timeline
          ? timeline.map((item): [string, ToolStep[]] => [item.runId, item.steps])
          : [...tools];
        const nextAsks = timeline
          ? timeline.flatMap((item) =>
              item.approval || item.question
                ? [
                    [item.runId, { approval: item.approval, question: item.question }] as [
                      string,
                      { approval?: RunApproval; question?: RunQuestion },
                    ],
                  ]
                : [],
            )
          : [...asks];
        const lastRun = activities
          .filter((activity) => activity.sessionId === sessionId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .at(-1);
        setCallTools(new Map(nextCallTools));
        setTools(new Map(nextTools));
        setAsks(new Map(nextAsks));
        setMessages(history);
        setSubagents(children);
        setPeople(new Map(members.map((person) => [person.id, person])));
        setRun(lastRun);
        setError('');
        shown.current = true;
        keep({
          messages: history,
          tools: nextTools,
          asks: nextAsks,
          callTools: nextCallTools,
          subagents: children,
          people: members,
          ...(lastRun ? { run: lastRun } : {}),
        });
      } catch (failure) {
        if (!stopped && !shown.current)
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

  // The gateway back in reach: what was said meanwhile, read at once. Nothing was heard while
  // the stream was down to ask for it.
  useEffect(
    () =>
      onlineManager.subscribe((online) => {
        if (online) setRetry((count) => count + 1);
      }),
    [],
  );

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

  // The turns still at work: their last stretch of tools is drawn at the end, not in place.
  const under = new Set([
    ...(run && isRunning ? [run.id] : []),
    ...(pendingCall && callRun && running(callRun) ? [callRun.id] : []),
  ]);

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
      <p role="status" className="sr-only">
        {loading ? 'Loading conversation…' : ''}
      </p>
      <section
        ref={scroller}
        className="message-history"
        aria-label="Session history"
        aria-busy={loading}
        onScroll={(event) => {
          onScroll(event.currentTarget);
        }}
      >
        <div className="message-list">
          {loading ? (
            <HistorySkeleton />
          ) : messages.length ? (
            messages.map((message, index) => {
              const previous = messages[index - 1];
              // The tools a turn used before saying anything go above the first thing it said.
              const opensAnswer =
                answers(message) &&
                !messages
                  .slice(0, index)
                  .some((item) => answers(item) && turnOf(item) === turnOf(message));
              const answering = turnOf(message);
              const place = answering && answers(message) ? placed.get(answering) : undefined;
              const steps = opensAnswer ? place?.head : undefined;
              // The tools after this line, until the next: under it, where they happened. The
              // last stretch of a turn still at work belongs to its working line at the end.
              const later =
                place && !(answering && under.has(answering) && place.last?.id === message.id)
                  ? place.after.get(message.id)
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
                const about = messages.filter((item) => turnOf(item) === runId);
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
              const thought =
                answering && (steps?.length || handedOff) ? (
                  <Worked
                    steps={steps ?? []}
                    startedAt={span(answering).startedAt}
                    {...(steps?.length ? {} : { finishedAt: span(answering).finishedAt })}
                    fresh={answering === newest}
                  />
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
                          drawn={
                            (message.runId ? tools.get(message.runId) : undefined)?.find(
                              (step) => step.toolName === 'generate_image' && step.aspectRatio,
                            )?.aspectRatio
                          }
                        />
                      )}
                    </ChatMessage>
                  )}
                  {later?.length ? (
                    <div className="chat-line theirs">
                      <Worked
                        steps={later}
                        startedAt={message.createdAt}
                        fresh={answering === newest}
                      />
                    </div>
                  ) : null}
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
            !error && (
              <div className="grid justify-items-center gap-1 py-16 text-center">
                <h3 className="text-sm font-semibold text-ink">No messages in this session</h3>
                <p className="text-sm">{empty}</p>
              </div>
            )
          )}
          {!loading && pendingCall && callRun && running(callRun) && (
            <LiveTurn run={callRun} {...trailing(callRun, callTools)} />
          )}
          {!loading && run && isRunning && (
            <LiveTurn run={run} {...trailing(run, tools)}>
              <CrewCards agents={subagents.filter((child) => child.parentRunId === run.id)} />
            </LiveTurn>
          )}
        </div>
      </section>
      <ConversationMap scroller={scroller} entries={mapEntries} />
      {/* A chat on WhatsApp or Telegram has no screen there to throw it on. */}
      <Confetti runs={tools} off={Boolean(chat)} />
      {/* What sits just above the composer: errors, a question waiting, agents at work. It
          floats with the composer over the end of the conversation. */}
      <div className="history-tray">
        {error && (
          <TroubleCard
            title="The conversation could not be loaded"
            detail={error}
            action="Try again"
            onAction={() => {
              setLoading(true);
              setRetry((value) => value + 1);
            }}
          />
        )}
        {/* The dots already say the agent is working; the card speaks only when a turn went wrong. */}
        {run && run.id !== dismissed && troubles[run.status as keyof typeof troubles] && (
          <TroubleCard
            title={troubles[run.status as keyof typeof troubles]}
            detail={`${run.error ?? fallbacks[run.status as keyof typeof troubles]}${
              retryRun && run.status !== 'cancelled' ? ' Retry or send a follow-up below.' : ''
            }`}
            {...(retryRun && run.status !== 'cancelled'
              ? { action: 'Retry', busy: deciding, onAction: () => settle(retryRun(run)) }
              : {})}
            onClose={() => setDismissed(run.id)}
          />
        )}
        <CrewDock agents={subagents} />
      </div>
    </div>
  );
}
