// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi } from '../../lib/api';
import { RETRY_MS } from './conversation/reader';
import { History, joinHistory } from './history';

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

const moment = (second: number) => new Date(Date.UTC(2026, 9, 29, 10, 0, second)).toISOString();

const line = (id: string, second: number, extra: Record<string, unknown> = {}) => ({
  id,
  profileId: 'profile',
  sessionId: 'session',
  runId: 'run',
  role: 'assistant' as const,
  content: `Said ${id}.`,
  createdAt: moment(second),
  ...extra,
});

const step = (id: string, second: number) => ({
  toolCallId: id,
  toolName: 'read_file',
  status: 'done' as const,
  startedAt: moment(second),
  finishedAt: moment(second),
});

const agentCard = (name: string, second: number, parentRunId = 'run') => ({
  runId: `child-${name}`,
  parentRunId,
  sessionId: `child-session-${name}`,
  name,
  role: 'execute',
  status: 'completed',
  input: 'Check.',
  tier: 'deep',
  tierBy: 'jev',
  modelSelection: { providerId: 'provider', modelId: 'test-model' },
  output: 'Passed.',
  createdAt: moment(second),
  updatedAt: moment(second),
});

const approval = {
  id: 'approval',
  kind: 'machine',
  title: 'Delete the archive',
  detail: 'It cannot be undone.',
  confirmLabel: 'Delete',
  request: '{"command":"rm -rf archive/"}',
  askedAt: moment(50),
};

const show = async (api: unknown) => {
  await act(async () =>
    root.render(<History api={api as GatewayApi} profileId="profile" sessionId="session" />),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

it('keeps what the agent said before it stopped to ask for approval', async () => {
  await show({
    messages: async () => [line('before', 1), line('asked', 3, { content: 'Waiting.' })],
    activities: async () => [],
    timeline: async () => [{ runId: 'run', steps: [], approval }],
    decideApproval: async () => ({}),
  });

  expect(element.textContent).toContain('Said before.');
  expect(element.textContent).toContain('Delete the archive');
  expect(element.textContent).not.toContain('Waiting.');
});

it('shows an agent made between two lines, even with the tools unread', async () => {
  await show({
    messages: async () => [line('first', 1), line('second', 3)],
    activities: async () => [],
    timeline: async () => {
      throw new Error('timeline unavailable');
    },
    conversationSubagents: async () => [agentCard('Verifier', 2)],
  });

  expect(element.textContent).toContain('Verifier');
  // Where it happened: after the first line, before the second.
  const text = element.textContent ?? '';
  expect(text.indexOf('Said first.')).toBeLessThan(text.indexOf('Verifier'));
  expect(text.indexOf('Verifier')).toBeLessThan(text.indexOf('Said second.'));
});

it('shows every reaction of lines that read as one answer', async () => {
  await show({
    messages: async () => [
      line('first', 1, { reactions: [{ actor: 'agent', emoji: '🎉' }] }),
      line('second', 2, { reactions: [{ actor: 'agent', emoji: '🚀' }] }),
    ],
    activities: async () => [],
    timeline: async () => [],
  });

  expect(element.querySelectorAll('.reaction-badge')).toHaveLength(2);
  expect(element.querySelectorAll('.chat-text')).toHaveLength(1);
});

/** A small generator with a seed, so a failing conversation can be read and run again. */
const random = (seed: number) => {
  let state = seed;
  return (below: number) => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return Math.floor((state / 4_294_967_296) * below);
  };
};

/**
 * Any conversation at all, in the shapes the gateway writes. Everything in `expected` must reach
 * the screen: the one line a card takes the place of is the only thing allowed not to.
 */
const conversation = (seed: number) => {
  const pick = random(seed);
  const messages: ReturnType<typeof line>[] = [];
  const timeline: {
    runId: string;
    steps: ReturnType<typeof step>[];
    approval?: typeof approval;
  }[] = [];
  const agents: ReturnType<typeof agentCard>[] = [];
  const expected = { lines: [] as string[], agents: [] as string[], reactions: 0, tools: 0 };
  let second = 0;
  const tick = () => {
    second += 1;
    return second;
  };
  const runs = 1 + pick(3);

  for (let turn = 0; turn < runs; turn++) {
    const runId = `run-${turn}`;
    const steps: ReturnType<typeof step>[] = [];
    messages.push(line(`ask-${turn}`, tick(), { runId, role: 'user', content: `Asked ${turn}.` }));
    expected.lines.push(`Asked ${turn}.`);

    const lines = 1 + pick(5);
    for (let index = 0; index < lines; index++) {
      const id = `${turn}-${index}`;
      const reacted = pick(4) === 0;
      messages.push(
        line(id, tick(), {
          runId,
          ...(reacted ? { reactions: [{ actor: 'agent', emoji: '🎉' }] } : {}),
        }),
      );
      expected.lines.push(`Said ${id}.`);
      if (reacted) expected.reactions += 1;
      if (pick(2) === 0) {
        steps.push(step(`${id}-tool`, tick()));
        expected.tools += 1;
      }
      if (pick(4) === 0) {
        const name = `Agent${id.replace('-', 'x')}`;
        agents.push(agentCard(name, tick(), runId));
        expected.agents.push(name);
      }
    }

    // The last turn may stop to ask, and its last line is the gateway's, drawn as the card.
    if (turn === runs - 1 && pick(3) === 0) {
      messages.push(line('gateway', tick(), { runId, content: 'Waiting for you.' }));
      timeline.push({ runId, steps, approval });
    } else {
      timeline.push({ runId, steps });
    }
  }

  return { messages, timeline, agents, expected };
};

it.each(Array.from({ length: 60 }, (_, seed) => seed + 1))(
  'loses nothing of any conversation (seed %i)',
  async (seed) => {
    const { messages, timeline, agents, expected } = conversation(seed);

    await show({
      messages: async () => messages,
      activities: async () => [],
      timeline: async () => timeline,
      conversationSubagents: async () => agents,
      decideApproval: async () => ({}),
    });

    const text = element.textContent ?? '';
    for (const said of expected.lines) expect(text).toContain(said);
    for (const name of expected.agents) expect(text).toContain(name);
    expect(element.querySelectorAll('.reaction-badge')).toHaveLength(expected.reactions);

    const counted = [...element.querySelectorAll('.thought-label')].reduce(
      (sum, label) => sum + Number(/(\d+) tool call/.exec(label.textContent ?? '')?.[1] ?? 0),
      0,
    );
    expect(counted).toBe(expected.tools);
  },
);

const page = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => {
    const number = from + index;
    return line(`m${number}`, number % 60, {
      createdAt: new Date(Date.UTC(2026, 9, 29, 10, 0, 0, number)).toISOString(),
      runId: `run-${number}`,
    });
  });

const earlier = () =>
  [...element.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Show earlier messages'),
  );

it('reads earlier messages and their tools when the first page is full', async () => {
  const timeline = vi.fn(async (_profile: string, _session: string, runs?: string[]) =>
    (runs ?? []).includes('run-3') ? [{ runId: 'run-3', steps: [step('old-tool', 3)] }] : [],
  );
  // Pages of 40, as the panel asks for: the latest, then the 30 before it, which is the start.
  const messages = vi.fn(
    async (_profile: string, _session: string, at?: { before?: string; limit?: number }) =>
      at?.before ? page(0, 30) : page(30, 70),
  );

  await show({ messages, activities: async () => [], timeline });

  expect(element.textContent).not.toContain('Said m29.');
  // A page's tools are asked for by its own turns, so an old page never lacks them.
  expect(timeline.mock.calls[0]?.[2]).toContain('run-30');

  await act(async () => earlier()?.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(messages.mock.calls.at(-1)?.[2]).toEqual({ before: 'm30', limit: 40 });
  const text = element.textContent ?? '';
  expect(text).toContain('Said m0.');
  expect(text.indexOf('Said m29.')).toBeLessThan(text.indexOf('Said m30.'));
  expect(text).toContain('1 tool call');
  // That was the beginning of the conversation: nothing further to offer.
  expect(earlier()).toBeUndefined();
});

it('offers nothing earlier when the conversation fits in one page', async () => {
  await show({
    messages: async () => page(0, 20),
    activities: async () => [],
    timeline: async () => [],
  });

  expect(earlier()).toBeUndefined();
});

it('says when earlier messages could not be read, and lets the owner try again', async () => {
  let failing = true;
  await show({
    messages: async (
      _profile: string,
      _session: string,
      at?: { before?: string; limit?: number },
    ) => {
      if (!at?.before) return page(50, 150);
      if (failing) throw new Error('offline');
      return page(0, 50);
    },
    activities: async () => [],
    timeline: async () => [],
  });

  await act(async () => earlier()?.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(element.textContent).toContain('Earlier messages could not be read.');

  failing = false;
  await act(async () => earlier()?.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(element.textContent).toContain('Said m0.');
  expect(element.textContent).not.toContain('could not be read');
});

it('says when the tools of a conversation could not be read, and reads them again on its own', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let failing = true;
    await show({
      messages: async () => [line('first', 1)],
      activities: async () => [],
      timeline: async () => {
        if (failing) throw new Error('offline');
        return [{ runId: 'run', steps: [step('tool', 2)] }];
      },
    });

    expect(element.textContent).toContain('tools could not be read');
    // Nothing to press: the reader tries again by itself.
    expect(
      [...element.querySelectorAll('button')].some((button) => button.textContent === 'Try again'),
    ).toBe(false);

    failing = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_MS[0] ?? 0);
    });

    expect(element.textContent).not.toContain('tools could not be read');
    expect(element.textContent).toContain('1 tool call');
  } finally {
    vi.useRealTimers();
  }
});

const said = (id: string) => ({ id });

it('joins what was read to what is known, keeping what scrolled out of the latest page', () => {
  const known = [said('a'), said('b'), said('c')];

  // A new line pushed `a` out of the latest page; it is still the conversation.
  expect(joinHistory(known, [said('b'), said('c'), said('d')]).map((item) => item.id)).toEqual([
    'a',
    'b',
    'c',
    'd',
  ]);
});

it('starts over when what was read does not meet what is known, leaving no silent gap', () => {
  const known = [said('a'), said('b')];

  expect(joinHistory(known, [said('x'), said('y')]).map((item) => item.id)).toEqual(['x', 'y']);
  expect(joinHistory(known, [])).toEqual([]);
});
