'use client';

import { MESSAGES_PAGE, STREAM_OPENED_EVENT } from '@jian/contracts';
import { onlineManager } from '@tanstack/react-query';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Action } from '../../kit/action';
import type {
  CodeDiff,
  GatewayApi,
  Message,
  Person,
  Profile,
  Run,
  RunApproval,
  RunQuestion,
  Subagent,
  ToolStep,
} from '../../lib/api';
import { subscribe } from '../../lib/events';
import { useCrew } from '../../lib/stores/crew';
import { forgetLanded, landed, useOutbox } from '../../lib/stores/outbox';
import { useReconnect } from '../../lib/stores/reconnect';
import { plainText } from '../ui/markdown';
import { FilePath } from './code-change';
import { Confetti } from './confetti';
import { ConversationMap } from './conversation-map';
import { CrewCards, placeCrew, reportOf } from './crew';
import { ApprovalCard, QuestionCard } from './decision-cards';
import { useFollowBottom } from './follow-bottom';
import { groupMessages } from './group-messages';
import { HistorySkeleton } from './history-skeleton';
import { focusInspector } from './inspector-host';
import { useKeptHistory } from './kept-history';
import { MessageMedia } from './media';
import { authored, ChatMessage } from './message';
import { OutgoingMessage } from './outgoing';
import { LiveTurn, placeSteps, traceOf } from './progress';
import { running } from './status';
import { ThoughtLine } from './thought-line';
import { TroubleCard } from './trouble';

/**
 * Who answers a message: the agent, or — on a question this profile carried to another agent —
 * that agent, whose run is kept in its own profile.
 */
/**
 * How long a turn at work may go without a word from the stream before the conversation is read
 * anyway, in ms, and the longest the wait grows to while the silence lasts.
 */
const QUIET_READ_MS = 4_000;
const QUIET_READ_MAX_MS = 30_000;
/** How close to the top of the conversation, in px, reading further back begins. */
const EARLIER_WITHIN_PX = 400;

const answers = (message: Message) =>
  message.call ? message.role === 'user' : message.role === 'assistant';
const turnOf = (message: Message) => message.call?.runId ?? message.runId;
/** A person's own line in a turn: the one that opened it, or one sent while it ran. */
const toldTurn = (message: Message) =>
  message.role === 'user' && !message.call && !message.purpose && Boolean(message.runId);
/** When a stretch of tools ended: its last tool's end, so a settled line stops its clock there. */
const endOf = (steps: ToolStep[]) =>
  steps
    .map((step) => step.finishedAt ?? step.startedAt)
    .sort()
    .at(-1);

/** Tools a turn used between two things it said, settled, with the files they changed. */
function RunChangesSummary({
  steps,
  onOpen,
}: {
  steps: ToolStep[];
  onOpen: (step: ToolStep & { diff: CodeDiff }, opener: HTMLButtonElement) => void;
}) {
  const files = new Map<string, ToolStep & { diff: CodeDiff }>();
  for (const step of steps) {
    if (step.status === 'done' && step.diff)
      files.set(step.diff.path, step as ToolStep & { diff: CodeDiff });
  }
  if (!files.size) return null;

  return (
    <div className="chat-line theirs">
      <section className="run-change-summary" aria-label="Files changed in this run">
        <p className="run-change-summary-title">Files changed</p>
        <ul>
          {[...files.values()].map((step) => (
            <li key={`${step.toolCallId}:${step.diff.path}`}>
              <button
                type="button"
                aria-label={`${step.diff.path}, ${step.diff.additions} added, ${step.diff.deletions} removed`}
                onClick={(event) => onOpen(step, event.currentTarget)}
              >
                <span className="run-change-summary-path">
                  <FilePath path={step.diff.path} />
                </span>
                <span className="run-change-summary-counts" aria-hidden="true">
                  <i>+{step.diff.additions}</i> <b>−{step.diff.deletions}</b>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Worked({
  steps,
  startedAt,
  finishedAt = endOf(steps),
}: {
  steps: ToolStep[];
  startedAt?: string;
  finishedAt?: string;
}) {
  return (
    <ThoughtLine
      working={false}
      steps={traceOf(steps)}
      startedAt={startedAt}
      finishedAt={finishedAt}
    />
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

/**
 * What was just read, joined to what is already known. A new line pushes the oldest out of the
 * latest page, and it stays: the reader has it on screen, and earlier pages end right above it.
 * What was read that does not meet what is known starts over, since keeping both would hide a
 * gap in the conversation behind what looks like a whole one.
 */
export function joinHistory<Item extends { id: string }>(known: Item[], latest: Item[]): Item[] {
  const first = latest[0];
  if (!first) return [];
  const meets = known.findIndex((item) => item.id === first.id);

  return meets < 0 ? latest : [...known.slice(0, meets), ...latest];
}

/** What a read says of each turn it asked about, over what was known of the others. */
function overTurns<Value>(known: Map<string, Value>, asked: string[], read: [string, Value][]) {
  const next = new Map(known);
  for (const turn of asked) next.delete(turn);
  for (const [turn, value] of read) next.set(turn, value);

  return next;
}

export function History({
  api,
  agent,
  agents = [],
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
   * The channel a chat's approvals and questions are answered in, by name. Its cards show what
   * is waiting and how it went, without buttons: there, only the chat decides.
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
}) {
  // Asked for from the palette: what is on screen stays while it is read again.
  const reloads = useReconnect((state) => state.chat);
  // Read before: shown at once, and read again behind it.
  const { kept, keep } = useKeptHistory(profileId, sessionId);
  const [messages, setMessages] = useState<Awaited<ReturnType<GatewayApi['messages']>>>(
    kept?.messages ?? [],
  );
  const [people, setPeople] = useState(
    new Map<string, Person>(kept?.people.map((person) => [person.id, person])),
  );
  const [tools, setTools] = useState(new Map<string, ToolStep[]>(kept?.tools));
  // What the owner sent here that the conversation does not hold yet, drawn after it; a sent
  // one leaves as soon as the history brings the stored message back.
  const outbox = useOutbox((state) => state.items);
  const outgoing = useMemo(
    () => outbox.filter((item) => item.sessionId === sessionId && !landed(item, messages)),
    [outbox, sessionId, messages],
  );
  useEffect(() => {
    forgetLanded(
      outbox
        .filter((item) => item.sessionId === sessionId && landed(item, messages))
        .map((item) => item.key),
    );
  }, [outbox, sessionId, messages]);
  // Turns the owner started from here that no read of the gateway has brought back yet, with
  // when the gateway was seen to take each: the agent is drawn starting at once instead of after
  // the next read. Timed from the taking, not the click: a read that began in between may not
  // hold the turn yet, and must not be taken for one that does.
  const [awaited, setAwaited] = useState(new Map<string, string>());
  useEffect(() => {
    const sent = outbox.filter(
      (item) => item.sessionId === sessionId && item.state === 'sent' && item.runId,
    );
    setAwaited((known) => {
      const fresh = sent.filter((item) => item.runId && !known.has(item.runId));
      if (!fresh.length) return known;
      const taken = new Date().toISOString();
      return new Map([...known, ...fresh.map((item) => [item.runId ?? '', taken] as const)]);
    });
  }, [outbox, sessionId]);
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
  // The last reload the owner asked for that has had its outcome.
  const answered = useRef(reloads);
  // Bumped by an event about this conversation, so it reads again the moment something happens.
  const [heard, setHeard] = useState(0);
  // When the stream last said something about this conversation, and when it was last read
  // without being told to, in ms.
  const streamAt = useRef(Date.now());
  const polledAt = useRef(0);
  const [deciding, setDeciding] = useState(false);
  // The failed turn whose card the owner closed; a later one shows its own.
  const [dismissed, setDismissed] = useState<string>();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const stop = subscribe((event) => {
      if (event.type === 'conversation.inspector.focus') {
        focusInspector(sessionId, event.data as Parameters<typeof focusInspector>[1]);
        return;
      }
      if (
        !event.type.startsWith('run.') &&
        !event.type.startsWith('session.') &&
        event.type !== 'conversation.subagent.spawned' &&
        event.type !== STREAM_OPENED_EVENT
      )
        return;
      const about =
        (event.data as { sessionId?: string; parentSessionId?: string } | undefined)?.sessionId ??
        (event.data as { parentSessionId?: string } | undefined)?.parentSessionId;

      if (about && about !== sessionId) return;
      streamAt.current = Date.now();
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
  const previewed = useRef(new Set<string>());
  useEffect(() => {
    for (const live of [run, callRun]) {
      if (live?.progress?.text) previewed.current.add(live.id);
    }
  }, [run, callRun]);
  // A persisted message can reach a read before its matching progress snapshot is cleared.
  const alreadySaid = (live: Run) =>
    live.progress?.phase === 'writing' &&
    Boolean(live.progress.text) &&
    messages.some(
      (message) =>
        answers(message) &&
        turnOf(message) === live.id &&
        message.content.trim() === live.progress?.text.trim(),
    );
  const [loading, setLoading] = useState(!kept);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  // The last read of the tools failed: the conversation on screen may lack them.
  const [toolsUnread, setToolsUnread] = useState(false);
  // The last read failed altogether: what is on screen stays, but may be behind.
  const [behind, setBehind] = useState(false);
  // How reading further back went, and whether the beginning was reached.
  const [earlier, setEarlier] = useState<'idle' | 'reading' | 'failed'>('idle');
  const [atBeginning, setAtBeginning] = useState(false);
  const readingEarlier = useRef(false);
  const isRunning = running(run);
  const crewPlacement = useMemo(
    () => placeCrew(subagents, messages.filter(answers)),
    [subagents, messages],
  );
  // A line the owner sent while a turn was already at work joins that turn, and divides its work
  // as the agent's own lines do: what was done before it stays above it, what came after goes
  // below, while the turn runs and once it ends alike.
  const steers = useMemo(() => {
    const opened = new Set<string>();
    const sent = new Set<string>();

    for (const message of messages) {
      if (!toldTurn(message) || !message.runId) continue;
      if (opened.has(message.runId)) sent.add(message.id);
      else opened.add(message.runId);
    }
    return sent;
  }, [messages]);
  // Each turn's tools among the lines it said, so the work shows up as it was spoken.
  const placed = useMemo(() => {
    const said = new Map<string, { lines: Message[]; call: boolean }>();

    for (const message of messages) {
      const turn = turnOf(message);
      if (!turn || !(answers(message) || steers.has(message.id))) continue;
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
  }, [messages, tools, callTools, steers]);
  const shownMessages = useMemo(
    () => groupMessages(messages, placed, crewPlacement.before, asks),
    [messages, placed, crewPlacement, asks],
  );
  const hasEarlier = !atBeginning && messages.length >= MESSAGES_PAGE;
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

  /**
   * The tools of a page of messages, asked for by that page's own turns, so an old page never
   * lacks them. The other agent's tools are read where it worked: its own session, in its profile.
   */
  const readTurns = async (page: Message[], under?: string) => {
    const turns = [
      ...new Set([
        ...page.flatMap((message) => (message.runId ? [message.runId] : [])),
        ...(under ? [under] : []),
      ]),
    ];
    const calls = new Map<string, { profileId: string; sessionId: string; runs: string[] }>();
    for (const { call } of page) {
      if (!call) continue;
      const place = `${call.profileId}/${call.sessionId}`;
      const known = calls.get(place) ?? { ...call, runs: [] };
      known.runs.push(call.runId);
      calls.set(place, known);
    }
    const [timeline, worked] = await Promise.all([
      api.timeline
        ? api.timeline(profileId, sessionId, turns).catch(() => undefined)
        : Promise.resolve(undefined),
      api.timeline
        ? Promise.all(
            [...calls.values()].map((call) =>
              api.timeline?.(call.profileId, call.sessionId, call.runs).catch(() => undefined),
            ),
          )
        : Promise.resolve([]),
    ]);
    const steps = (timeline ?? []).map((item): [string, ToolStep[]] => [item.runId, item.steps]);
    const asked = (timeline ?? []).flatMap((item) =>
      item.approval || item.question
        ? [
            [item.runId, { approval: item.approval, question: item.question }] as [
              string,
              { approval?: RunApproval; question?: RunQuestion },
            ],
          ]
        : [],
    );

    return {
      turns,
      callTurns: [...calls.values()].flatMap((call) => call.runs),
      steps,
      asked,
      called: worked
        .flatMap((item) => item ?? [])
        .map((item): [string, ToolStep[]] => [item.runId, item.steps]),
      unread:
        Boolean(api.timeline) &&
        (timeline === undefined || worked.some((item) => item === undefined)),
      toolsRead: timeline !== undefined,
      callsRead: worked.every((item) => item !== undefined),
    };
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and revision explicitly restart the read.
  useEffect(() => {
    let stopped = false;
    const read = async () => {
      const began = new Date().toISOString();
      try {
        // The transcript is the part the owner came to see. Start its request with the supporting
        // reads, but do not make the conversation wait for a second trip to fetch its timeline.
        const historyRequest = api.messages(profileId, sessionId);
        const supportingReads = Promise.all([
          api.activities(profileId),
          group && api.people ? api.people(profileId, sessionId) : [],
          api.conversationSubagents?.(profileId, sessionId) ?? [],
        ]).then(
          (result) => ({ result }),
          (failure) => ({ failure }),
        );
        const history = await historyRequest;
        if (stopped) return;
        // A reload the owner asked for starts from what the gateway says now, and nothing else.
        const fresh = answered.current !== reloads;
        setMessages((known) => joinHistory(fresh ? [] : known, history));
        if (fresh) {
          setAtBeginning(false);
          setEarlier('idle');
        }
        setError('');
        setBehind(false);
        shown.current = true;
        setLoading(false);

        const supporting = await supportingReads;
        // Superseded while it waited: a newer read says what is at work now.
        if (stopped) return;
        if ('failure' in supporting) throw supporting.failure;
        const [activities, members, children] = supporting.result;
        const lastRun = activities
          .filter((activity) => activity.sessionId === sessionId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .at(-1);
        // The turn at work is drawn now; its tools follow when the timeline answers.
        setRun(lastRun);
        // A turn sent before this read began is in what it read, at work or already over.
        setAwaited((known) =>
          [...known.values()].some((at) => at < began)
            ? new Map([...known].filter(([, at]) => at >= began))
            : known,
        );
        const read = await readTurns(history, lastRun?.id);
        if (stopped) return;
        // What a part that could not be read leaves as it was.
        if (read.toolsRead) {
          setTools((known) => overTurns(fresh ? new Map() : known, read.turns, read.steps));
          setAsks((known) => overTurns(fresh ? new Map() : known, read.turns, read.asked));
        }
        if (read.callsRead) {
          setCallTools((known) =>
            overTurns(fresh ? new Map() : known, read.callTurns, read.called),
          );
        }
        setSubagents(children);
        setPeople(new Map(members.map((person) => [person.id, person])));
        setToolsUnread(read.unread);
        answered.current = reloads;
        if (fresh) toast.success('Chat reloaded.');
        keep({
          messages: history,
          tools: read.toolsRead ? read.steps : [...tools],
          asks: read.toolsRead ? read.asked : [...asks],
          callTools: read.callsRead ? read.called : [...callTools],
          subagents: children,
          people: members,
          ...(lastRun ? { run: lastRun } : {}),
        });
      } catch (failure) {
        if (stopped) return;
        const said =
          failure instanceof Error ? failure.message : 'The history could not be loaded.';
        if (shown.current) setBehind(true);
        if (!shown.current) setError(said);
        // What is on screen stays, but a reload the owner asked for does not fail in silence.
        else if (answered.current !== reloads) {
          answered.current = reloads;
          toast.error(`This chat could not be reloaded: ${said}`);
        }
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    void read();
    return () => {
      stopped = true;
    };
  }, [api, profileId, sessionId, retry, revision, reloads, group, heard]);

  // Further back in the conversation: its page, with that page's tools, above what is shown.
  const scrolledFrom = useRef<{ top: number; height: number }>(undefined);
  const readEarlier = async () => {
    const oldest = messages[0];
    if (!oldest || readingEarlier.current) return;
    readingEarlier.current = true;
    setEarlier('reading');
    try {
      const page = await api.messages(profileId, sessionId, oldest.id);
      const shownIds = new Set(messages.map((message) => message.id));
      // A gateway that cannot page answers its latest messages again: nothing new, so stop.
      const fresh = page.filter((message) => !shownIds.has(message.id));
      const read = await readTurns(fresh);
      const view = scroller.current;
      if (view) scrolledFrom.current = { top: view.scrollTop, height: view.scrollHeight };
      if (read.toolsRead) {
        setTools((known) => overTurns(known, read.turns, read.steps));
        setAsks((known) => overTurns(known, read.turns, read.asked));
      }
      if (read.callsRead) setCallTools((known) => overTurns(known, read.callTurns, read.called));
      if (read.unread) setToolsUnread(true);
      setMessages((known) => [...fresh, ...known]);
      if (page.length < MESSAGES_PAGE || !fresh.length) setAtBeginning(true);
      setEarlier('idle');
    } catch {
      setEarlier('failed');
    } finally {
      readingEarlier.current = false;
    }
  };

  // The reader stays on the line they were reading as earlier ones appear above it. Set outright
  // rather than added to: a browser that anchors scrolling has already moved it by some amount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages growing is what this answers.
  useLayoutEffect(() => {
    const from = scrolledFrom.current;
    const view = scroller.current;
    if (!from || !view) return;
    scrolledFrom.current = undefined;
    view.scrollTop = from.top + view.scrollHeight - from.height;
  }, [messages, scroller]);

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

  // Sent from here and not yet seen at work: the agent shows as starting until a read says more.
  const sending = outgoing.filter((item) => item.state === 'sending').map((item) => item.at);
  const startingAt =
    !isRunning && (sending.length || awaited.size)
      ? [...sending, ...awaited.values()].sort().at(-1)
      : undefined;

  // While a turn is at work or awaited, a stream that went quiet is not taken at its word: the
  // conversation is read again after a few seconds of silence, then less and less often, and
  // back to listening as soon as the stream speaks. A stream that drops without failing would
  // otherwise leave the turn frozen on screen until it ends.
  const awaiting = isRunning || Boolean(startingAt);
  const working = isRunning ? run : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: told only when the turn at work changes.
  useEffect(() => onWork?.(working), [working?.id]);
  useEffect(() => {
    if (!awaiting) return;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      if (streamAt.current > polledAt.current) polls = 0;
      const quiet = Date.now() - Math.max(streamAt.current, polledAt.current);
      if (quiet >= Math.min(QUIET_READ_MS * 2 ** polls, QUIET_READ_MAX_MS)) {
        polls += 1;
        polledAt.current = Date.now();
        setHeard((value) => value + 1);
      }
      timer = setTimeout(check, 1000);
    };
    timer = setTimeout(check, 1000);
    return () => clearTimeout(timer);
  }, [awaiting]);

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
          // Before the reader reaches the top, so a long scroll back does not stop at each page.
          if (
            event.currentTarget.scrollTop < EARLIER_WITHIN_PX &&
            hasEarlier &&
            earlier === 'idle'
          ) {
            void readEarlier();
          }
        }}
      >
        <div className="message-list">
          {!loading && hasEarlier && (
            <div className="history-earlier">
              {earlier === 'failed' && <p>Earlier messages could not be read.</p>}
              <Action
                tone="quiet"
                size="small"
                busy={earlier === 'reading'}
                onClick={() => void readEarlier()}
              >
                Show earlier messages
              </Action>
            </div>
          )}
          {loading ? (
            <HistorySkeleton />
          ) : messages.length ? (
            shownMessages.map(({ message, lastMessage, index, lastIndex }) => {
              const previous = messages[index - 1];
              const steered = steers.has(message.id);
              const answering = turnOf(message);
              const place =
                answering && (answers(message) || steered) ? placed.get(answering) : undefined;
              // The tools a turn used before its first line go above that line: the first thing
              // it said, or a message the owner sent before it said anything.
              const steps = place?.first?.id === message.id ? place.head : undefined;
              // The tools after this line, until the next: under it, where they happened. The
              // last stretch of a turn still at work belongs to its working line at the end.
              const later =
                place && !(answering && under.has(answering) && place.last?.id === lastMessage.id)
                  ? place.after.get(lastMessage.id)
                  : undefined;
              const unansweredSteps =
                message.role === 'user' &&
                !message.call &&
                message.runId &&
                !placed.has(message.runId) &&
                !(run?.id === message.runId && isRunning) &&
                !messages.some(
                  (item) => item.role === 'assistant' && item.runId === message.runId,
                ) &&
                !messages
                  .slice(lastIndex + 1)
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
              // The run whose last line this is, once it settled: every finished run keeps its
              // files under its last line, not only the latest, which a new message replaces.
              const settledRun =
                answering &&
                answers(message) &&
                (answering !== run?.id || (!isRunning && run.status !== 'waiting')) &&
                !messages
                  .slice(lastIndex + 1)
                  .some((item) => answers(item) && turnOf(item) === answering)
                  ? answering
                  : undefined;
              const crew =
                message.runId && !live && messages[lastIndex + 1]?.runId !== message.runId
                  ? (crewPlacement.tail.get(message.runId) ?? [])
                  : [];
              const beforeCrew = crewPlacement.before.get(message.id) ?? [];
              // A finished agent's report is the agent's mail; its card already says it ended.
              const report = reportOf(message, subagents);
              // The line the gateway writes for an approval or a question becomes its card.
              // A run that stops to ask ends on the line it asked with: its last word is the
              // card, whatever the gateway wrote in it.
              const asked = message.runId ? asks.get(message.runId) : undefined;
              const asking =
                message.role === 'assistant' &&
                !messages
                  .slice(lastIndex + 1)
                  .some((later) => later.runId === message.runId && later.role === 'assistant');
              const approval = asking && asked?.approval ? asked.approval : undefined;
              const question = asking && asked?.question ? asked.question : undefined;
              // What the gateway wrote around a pause stays out of the conversation: the note
              // that tells the agent to carry on always, and the reply that answered or
              // decided, which its card already shows.
              const pause =
                message.purpose === 'resume' ||
                message.purpose === 'compact' ||
                (message.purpose === 'answer' && Boolean(asked?.question || asked?.approval));
              const thought =
                answering && steps?.length ? (
                  <Worked
                    steps={steps}
                    startedAt={steps[0]?.startedAt ?? span(answering).startedAt}
                    finishedAt={steps.at(-1)?.finishedAt ?? span(answering).finishedAt}
                  />
                ) : undefined;

              return (
                <Fragment key={message.id}>
                  {steered && thought ? (
                    <div className="chat-line theirs work">{thought}</div>
                  ) : null}
                  {report || pause ? null : approval && message.runId ? (
                    <div className="chat-line theirs">
                      {thought}
                      <CrewCards agents={beforeCrew} />
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
                      <CrewCards agents={beforeCrew} />
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
                      onReply={onReply ? () => onReply(message) : undefined}
                      onReact={
                        api.react
                          ? async (emoji) => {
                              const updated = await api.react?.(
                                profileId,
                                sessionId,
                                message.id,
                                emoji,
                              );
                              if (updated)
                                setMessages((known) =>
                                  known.map((item) => (item.id === updated.id ? updated : item)),
                                );
                            }
                          : undefined
                      }
                      entered={
                        answers(message) &&
                        Boolean(turnOf(message) && previewed.current.has(turnOf(message) ?? ''))
                      }
                      agent={
                        message.call && message.role === 'user'
                          ? agents.find((item) => item.id === message.call?.profileId)
                          : agent
                      }
                      group={group}
                      people={people}
                      opensRun={!previous || who(previous) !== who(message)}
                      before={
                        <>
                          {steered ? null : thought}
                          <CrewCards agents={beforeCrew} />
                        </>
                      }
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
                    <div className="chat-line theirs work">
                      <Worked steps={later} startedAt={lastMessage.createdAt} />
                    </div>
                  ) : null}
                  {unansweredSteps && message.runId && (
                    <div className="chat-line theirs work">
                      <ThoughtLine
                        working={false}
                        steps={traceOf(unansweredSteps)}
                        {...span(message.runId)}
                      />
                    </div>
                  )}
                  {crew.length > 0 && (
                    <div className="chat-line theirs">
                      <CrewCards agents={crew} />
                    </div>
                  )}
                  {settledRun && (
                    <RunChangesSummary
                      steps={tools.get(settledRun) ?? []}
                      onOpen={(step, opener) =>
                        useCrew.getState().showChanges({
                          runId: settledRun,
                          toolCallId: step.toolCallId,
                          path: step.diff.path,
                          opener,
                        })
                      }
                    />
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
          {!loading &&
            outgoing
              .filter((item) => !item.quiet || item.state === 'failed')
              .map((item) => (
                <OutgoingMessage
                  key={item.key}
                  item={item}
                  profileId={profileId}
                  people={people}
                  api={api}
                />
              ))}
          {!loading && startingAt && (
            <LiveTurn run={{ status: 'queued', createdAt: startingAt }} agent={agent} steps={[]} />
          )}
          {!loading && pendingCall && callRun && running(callRun) && !alreadySaid(callRun) && (
            <LiveTurn
              run={callRun}
              agent={agents.find((item) => item.id === pendingCall.profileId)}
              {...trailing(callRun, callTools)}
            />
          )}
          {!loading && run && isRunning && !alreadySaid(run) && (
            <LiveTurn run={run} agent={agent} {...trailing(run, tools)}>
              <CrewCards agents={crewPlacement.tail.get(run.id) ?? []} />
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
        {!loading && !error && (toolsUnread || (behind && onlineManager.isOnline())) && (
          <TroubleCard
            title={behind ? 'This conversation may be out of date' : 'Some tools could not be read'}
            detail={
              behind
                ? 'The latest read failed, so what is shown may be missing what happened since.'
                : 'The tools could not be read, so some of what the agent did may be missing here.'
            }
            action="Try again"
            onAction={() => setRetry((value) => value + 1)}
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
      </div>
    </div>
  );
}
