import { MESSAGES_FIRST_PAGE } from '@jian/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Message, Subagent, ToolStep } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';
import { CrewDrawer } from './crew-drawer';

type Api = Parameters<typeof CrewDrawer>[0]['api'];

const agentOf = (name: string, status: Subagent['status'] = 'completed') =>
  ({
    runId: `${name}-run`,
    sessionId: `${name}-session`,
    name,
    role: 'execute',
    status,
    createdAt: '2026-11-07T10:00:00Z',
    updatedAt: '2026-11-07T10:00:09Z',
  }) as Subagent;

const said = (agent: Subagent, content: string): Message => ({
  id: `${agent.runId}-said`,
  runId: agent.runId,
  sessionId: agent.sessionId,
  profileId: 'profile',
  role: 'assistant',
  content,
  createdAt: '2026-11-07T10:00:08Z',
});

const step = (toolCallId: string, extra: Partial<ToolStep> = {}): ToolStep => ({
  toolCallId,
  toolName: 'read_file',
  status: 'done',
  startedAt: '2026-11-07T10:00:01Z',
  finishedAt: '2026-11-07T10:00:02Z',
  ...extra,
});

/** A read the test answers when it chooses. */
function held<T>() {
  let answer!: (value: T) => void;
  let refuse!: (failure: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    answer = resolve;
    refuse = reject;
  });
  return { promise, answer, refuse };
}

const alpha = agentOf('alpha');
const beta = agentOf('beta');
let element: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  useCrew.getState().leave('parent');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const drawer = () => element.querySelector('.crew-drawer');
const draw = (api: Api) =>
  act(async () => root.render(<CrewDrawer api={api} profileId="profile" />));
const follow = (agent: Subagent) => act(async () => useCrew.setState({ following: agent.runId }));

it('never shows one agent’s words under another, even while the other’s read is held', async () => {
  const betaRead = held<Message[]>();
  const api: Api = {
    messages: (_profile, session) =>
      session === alpha.sessionId
        ? Promise.resolve([said(alpha, 'Alpha drafted the outreach email.')])
        : betaRead.promise,
    timeline: async () => [],
  };
  useCrew.setState({ sessionId: 'parent', agents: [alpha, beta], following: alpha.runId });
  await draw(api);
  expect(drawer()?.textContent).toContain('Alpha drafted the outreach email.');

  await follow(beta);
  expect(drawer()?.getAttribute('aria-label')).toBe('beta');
  expect(drawer()?.textContent).not.toContain('Alpha drafted');
  expect(drawer()?.querySelector('[aria-busy="true"]')).not.toBeNull();

  await act(async () => betaRead.answer([said(beta, 'Beta removed the old channel.')]));
  expect(drawer()?.textContent).toContain('Beta removed the old channel.');
  expect(drawer()?.textContent).not.toContain('Alpha drafted');

  // Back on the first, what was read for it shows at once.
  await follow(alpha);
  expect(drawer()?.textContent).toContain('Alpha drafted the outreach email.');
  expect(drawer()?.textContent).not.toContain('Beta removed');
});

it('says a read failed without showing the agent before it', async () => {
  const api: Api = {
    messages: (_profile, session) =>
      session === alpha.sessionId
        ? Promise.resolve([said(alpha, 'Alpha drafted the outreach email.')])
        : Promise.reject(new Error('The gateway did not answer.')),
    timeline: async (_profile, session) =>
      session === alpha.sessionId ? [{ runId: alpha.runId, steps: [step('alpha-read')] }] : [],
  };
  useCrew.setState({ sessionId: 'parent', agents: [alpha, beta], following: alpha.runId });
  await draw(api);
  expect(drawer()?.querySelector('.thought-line')).not.toBeNull();

  await follow(beta);
  expect(drawer()?.textContent).toContain('The gateway did not answer.');
  expect(drawer()?.textContent).not.toContain('Alpha drafted');
  expect(drawer()?.querySelector('.thought-line')).toBeNull();
});

it('drops a read that lands after the drawer moved to another agent', async () => {
  const alphaRead = held<Message[]>();
  const api: Api = {
    messages: (_profile, session) =>
      session === alpha.sessionId
        ? alphaRead.promise
        : Promise.resolve([said(beta, 'Beta removed the old channel.')]),
    timeline: async () => [],
  };
  useCrew.setState({ sessionId: 'parent', agents: [alpha, beta], following: alpha.runId });
  await draw(api);
  await follow(beta);
  await act(async () => alphaRead.answer([said(alpha, 'Alpha drafted the outreach email.')]));

  expect(drawer()?.textContent).toContain('Beta removed the old channel.');
  expect(drawer()?.textContent).not.toContain('Alpha drafted');
});

it('asks for this run’s tools, brief, and a first page of its messages', async () => {
  const timeline = vi.fn(async () => []);
  const messages = vi.fn(async () => []);
  useCrew.setState({ sessionId: 'parent', agents: [alpha], following: alpha.runId });
  await draw({ messages, timeline });

  expect(timeline).toHaveBeenCalledWith('profile', alpha.sessionId, [alpha.runId], {
    brief: true,
  });
  expect(messages).toHaveBeenCalledWith('profile', alpha.sessionId, {
    limit: MESSAGES_FIRST_PAGE,
  });
});

it('polls a working agent one read at a time', async () => {
  vi.useFakeTimers();
  const working = agentOf('gamma', 'running');
  const reads: Array<ReturnType<typeof held<Message[]>>> = [];
  let open = 0;
  let most = 0;
  const api: Api = {
    messages: () => {
      const read = held<Message[]>();
      reads.push(read);
      open += 1;
      most = Math.max(most, open);
      return read.promise.finally(() => {
        open -= 1;
      });
    },
    timeline: async () => [],
  };
  useCrew.setState({ sessionId: 'parent', agents: [working], following: working.runId });
  await draw(api);
  expect(reads).toHaveLength(1);

  // A slow gateway: many poll intervals pass while the first read is out.
  await act(async () => vi.advanceTimersByTime(6000));
  expect(reads).toHaveLength(1);

  await act(async () => reads[0]?.answer([]));
  await act(async () => vi.advanceTimersByTime(1500));
  expect(reads).toHaveLength(2);
  expect(most).toBe(1);
});

it('keeps the tools it showed after the agent ends, when the last read fails', async () => {
  const working = agentOf('delta', 'running');
  let fail = false;
  const api: Api = {
    // The words still come; only the tools do not, the way a slow link drops the heavier read.
    messages: async () => [said(working, 'Delta checked the settings.')],
    timeline: async () => {
      if (fail) throw new Error('Connection lost.');
      return [{ runId: working.runId, steps: [step('settings')] }];
    },
  };
  useCrew.setState({ sessionId: 'parent', agents: [working], following: working.runId });
  await draw(api);
  expect(drawer()?.querySelector('.thought-line')).not.toBeNull();

  fail = true;
  await act(async () => useCrew.setState({ agents: [{ ...working, status: 'completed' }] }));
  expect(drawer()?.textContent).toContain('Connection lost.');
  expect(drawer()?.textContent).toContain('Delta checked the settings.');
  expect(drawer()?.querySelector('.thought-line')).not.toBeNull();
});

it('opens a cut tool whole from the agent’s own session', async () => {
  const toolStep = vi.fn(async () =>
    step('read', { output: 'Every line of the notes, read whole.' }),
  );
  const api = {
    messages: async () => [said(alpha, 'Alpha read the notes.')],
    timeline: async () => [
      {
        runId: alpha.runId,
        steps: [step('read', { brief: true, output: 'Every line', outputTruncated: true })],
      },
    ],
    toolStep,
  } as unknown as GatewayApi;
  useCrew.setState({ sessionId: 'parent', agents: [alpha], following: alpha.runId });
  await draw(api);
  act(() => element.querySelector<HTMLButtonElement>('.thought-head')?.click());
  const details = element.querySelector<HTMLDetailsElement>('.thought-tool');
  await act(async () => {
    if (!details) return;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });

  expect(toolStep).toHaveBeenCalledWith('profile', alpha.sessionId, alpha.runId, 'read');
  expect(details?.textContent).toContain('Every line of the notes, read whole.');
});
