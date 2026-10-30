import { AGENT_SESSION_CHANNEL, GATEWAY_SESSION_CHANNEL } from '@jian/contracts';

/** A conversation as an agent's list gives it: enough to tell what is new in it. */
export type ListedSession = {
  id: string;
  title?: string | null;
  channel: string;
  scope?: 'direct' | 'group';
  readAt?: string;
  lastMessage?: { role: 'user' | 'assistant'; text: string; at: string };
};

/** A run still open on the gateway; a waiting one carries what it waits on. */
export type OpenRun = {
  id: string;
  sessionId: string;
  status: string;
  subagent?: unknown;
  question?: { id: string; prompt: string };
  approval?: { id: string; title: string };
};

/** What the app learned of one agent's conversations at its last look. */
export type AgentKnown = {
  /** The time of the last message in each conversation, by its id. */
  said: Map<string, string>;
  /** Every question and approval waiting on the owner, by run and by what it asks. */
  asking: Set<string>;
  /** The agent's chats of the panel with a reply the owner has not read. */
  unread: number;
};

/** Something new in a conversation, which the app may announce. */
export type News = {
  sessionId: string;
  title: string;
  text: string;
  /** The agent waits on the owner: a question or an approval, which blocks its work. */
  asks: boolean;
};

/** The conversations of a messaging app, as the panel names their channels. */
const MESSAGING = new Set(['whatsapp', 'whatsapp-business', 'telegram']);

/** The panel's own rule: a chat of the panel the agent wrote in since the owner last read it. */
function unread(session: ListedSession): boolean {
  return (
    session.channel === GATEWAY_SESSION_CHANNEL &&
    session.lastMessage?.role === 'assistant' &&
    (!session.readAt || Date.parse(session.lastMessage.at) > Date.parse(session.readAt))
  );
}

/**
 * Whether a new last message is worth a word. In a chat of the panel, the agent's reply the owner
 * has not read; their own message never. In a conversation with a person on a messaging app, or
 * with another agent, what either side says, but not the chatter of a group the agent only read.
 * An agent's own notes to itself, its tasks and the API's calls are not conversations to follow.
 */
function worthTelling(session: ListedSession): boolean {
  if (session.channel === GATEWAY_SESSION_CHANNEL) return unread(session);
  if (!MESSAGING.has(session.channel) && session.channel !== AGENT_SESSION_CHANNEL) return false;
  return !(session.scope === 'group' && session.lastMessage?.role === 'user');
}

/**
 * A conversation with no title yet. A channel's stored title already says where it happens,
 * as in `WhatsApp · Ana`, which is what a notification about it needs.
 */
function untitled(channel: string): string {
  if (channel === GATEWAY_SESSION_CHANNEL) return 'New chat';
  return channel === AGENT_SESSION_CHANNEL ? 'Agent' : 'Unknown contact';
}

/** The text a notification shows: one line, the markdown marks that read as noise gone. */
function plain(text: string, limit = 180): string {
  const line = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * What changed in one agent's conversations since the last look, and what to remember for the
 * next. The first look only learns: what was there when the app started is not news. `runs` is
 * undefined when they could not be read; what waited before is kept, so nothing is told twice.
 * A chat that now asks something is told once, as asking: that blocks the agent, its reply does not.
 */
export function readNews(
  before: AgentKnown | undefined,
  sessions: ListedSession[],
  runs: OpenRun[] | undefined,
): { known: AgentKnown; news: News[] } {
  const known: AgentKnown = {
    said: new Map(),
    asking: runs ? new Set() : new Set(before?.asking),
    unread: 0,
  };
  const titles = new Map<string, string>();
  const said: News[] = [];
  for (const session of sessions) {
    const title = session.title || untitled(session.channel);
    titles.set(session.id, title);
    if (unread(session)) known.unread += 1;
    const last = session.lastMessage;
    if (!last) continue;
    known.said.set(session.id, last.at);
    if (!before || before.said.get(session.id) === last.at || !worthTelling(session)) continue;
    said.push({ sessionId: session.id, title, text: plain(last.text), asks: false });
  }

  const asked: News[] = [];
  for (const run of runs ?? []) {
    // A subagent waits on the agent that started it, never on the owner.
    if (run.status !== 'waiting' || run.subagent) continue;
    const waiting = run.approval ?? run.question;
    if (!waiting) continue;
    const key = `${run.id}/${waiting.id}`;
    known.asking.add(key);
    if (!before || before.asking.has(key)) continue;
    asked.push({
      sessionId: run.sessionId,
      title: titles.get(run.sessionId) ?? 'New chat',
      text: run.approval
        ? plain(`Waiting for your approval: ${run.approval.title}`)
        : plain(`Asks: ${run.question?.prompt ?? ''}`),
      asks: true,
    });
  }

  const asking = new Set(asked.map((item) => item.sessionId));
  return { known, news: [...said.filter((item) => !asking.has(item.sessionId)), ...asked] };
}
