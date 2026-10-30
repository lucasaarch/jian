import { describe, expect, it } from 'vitest';
import { type ListedSession, type OpenRun, readNews } from '../src/main/gateways/news';

const read = '2026-10-30T09:00:00.000Z';

const chat = (
  id: string,
  at: string,
  role: 'user' | 'assistant' = 'assistant',
  more: Partial<ListedSession> = {},
): ListedSession => ({
  id,
  title: `Chat ${id}`,
  channel: 'gateway',
  readAt: read,
  lastMessage: { role, text: `**Done** with ${id}.`, at },
  ...more,
});

const waiting = (id: string, sessionId: string, kind: 'question' | 'approval'): OpenRun => ({
  id,
  sessionId,
  status: 'waiting',
  ...(kind === 'question'
    ? { question: { id: `${id}-q`, prompt: 'Which branch should I merge into?' } }
    : { approval: { id: `${id}-a`, title: 'Delete 12 projects' } }),
});

describe('what is new in an agent’s conversations', () => {
  it('only learns on the first look, then tells a reply the owner has not read', () => {
    const first = readNews(undefined, [chat('a', '2026-10-30T10:00:00.000Z')], []);
    expect(first.news).toEqual([]);
    expect(first.known.unread).toBe(1);

    const next = readNews(first.known, [chat('a', '2026-10-30T10:05:00.000Z')], []);
    expect(next.news).toEqual([
      { sessionId: 'a', title: 'Chat a', text: 'Done with a.', asks: false },
    ]);
    // The same word, seen again, is not news twice.
    expect(readNews(next.known, [chat('a', '2026-10-30T10:05:00.000Z')], []).news).toEqual([]);
  });

  it('keeps quiet about the owner’s own message and a reply already read elsewhere', () => {
    const first = readNews(undefined, [chat('a', '2026-10-30T10:00:00.000Z')], []);
    const own = readNews(first.known, [chat('a', '2026-10-30T10:01:00.000Z', 'user')], []);
    expect(own.news).toEqual([]);
    const readOnPhone = readNews(
      own.known,
      [chat('a', '2026-10-30T10:02:00.000Z', 'assistant', { readAt: '2026-10-30T10:03:00.000Z' })],
      [],
    );
    expect(readOnPhone.news).toEqual([]);
  });

  it('tells what a contact or another agent says, but not a group the agent only read', () => {
    const at = '2026-10-30T10:00:00.000Z';
    const later = '2026-10-30T10:01:00.000Z';
    const sessions = (when: string) => [
      chat('ana', when, 'user', {
        channel: 'whatsapp',
        title: 'WhatsApp · Ana',
        readAt: undefined,
      }),
      chat('team', when, 'user', { channel: 'telegram', scope: 'group', readAt: undefined }),
      chat('peer', when, 'user', { channel: 'agent', title: 'Agent · Researcher' }),
      chat('notes', when, 'assistant', { channel: 'learning' }),
    ];
    const first = readNews(undefined, sessions(at), []);
    const next = readNews(first.known, sessions(later), []);
    expect(next.news.map((item) => item.title)).toEqual(['WhatsApp · Ana', 'Agent · Researcher']);
  });

  it('tells a question or an approval once, over the reply in the same chat', () => {
    const at = '2026-10-30T10:00:00.000Z';
    const first = readNews(undefined, [chat('a', at), chat('b', at)], []);
    const later = '2026-10-30T10:05:00.000Z';
    const runs = [waiting('r1', 'a', 'approval'), waiting('r2', 'b', 'question')];
    const next = readNews(first.known, [chat('a', later), chat('b', at)], runs);
    expect(next.news).toEqual([
      {
        sessionId: 'a',
        title: 'Chat a',
        text: 'Waiting for your approval: Delete 12 projects',
        asks: true,
      },
      {
        sessionId: 'b',
        title: 'Chat b',
        text: 'Asks: Which branch should I merge into?',
        asks: true,
      },
    ]);
    expect(readNews(next.known, [chat('a', later), chat('b', at)], runs).news).toEqual([]);
  });

  it('does not tell again what still waits when the runs could not be read once', () => {
    const at = '2026-10-30T10:00:00.000Z';
    const first = readNews(undefined, [chat('a', at)], []);
    const runs = [waiting('r1', 'a', 'question')];
    const asked = readNews(first.known, [chat('a', at)], runs);
    expect(asked.news).toHaveLength(1);
    const blind = readNews(asked.known, [chat('a', at)], undefined);
    expect(readNews(blind.known, [chat('a', at)], runs).news).toEqual([]);
  });

  it('leaves a subagent’s wait to its agent, which alone may answer it', () => {
    const at = '2026-10-30T10:00:00.000Z';
    const first = readNews(undefined, [chat('a', at)], []);
    const run = { ...waiting('r1', 'a', 'question'), subagent: { name: 'reviewer' } };
    expect(readNews(first.known, [chat('a', at)], [run]).news).toEqual([]);
  });
});
