// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Subagent } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';
import { SessionAgents } from './session-agents';

const at = '2026-11-07T10:00:00.000Z';
const agent = (id: number, status: Subagent['status'], name = `Agent ${id}`): Subagent => ({
  runId: `00000000-0000-4000-8000-00000000000${id}`,
  sessionId: `10000000-0000-4000-8000-00000000000${id}`,
  parentRunId: '20000000-0000-4000-8000-000000000000',
  role: 'execute',
  name,
  status,
  input: 'Look into the queue',
  createdAt: at,
  updatedAt: at,
});

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
  document.body.innerHTML = '';
  useCrew.getState().leave(useCrew.getState().sessionId ?? '');
});

const render = (sessionId = 'session') =>
  act(async () => root.render(<SessionAgents sessionId={sessionId} />));
const trigger = () => element.querySelector<HTMLElement>('.session-badge-trigger');
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.session-agent')];
const open = () => act(async () => trigger()?.click());
/** The History shows the open conversation's agents to the store on every read. */
const read = (agents: Subagent[], sessionId = 'session') =>
  act(async () => useCrew.getState().show(sessionId, agents));

it('shows nothing while no subagent works', async () => {
  await read([agent(1, 'completed'), agent(2, 'failed')]);
  await render();

  expect(trigger()).toBeNull();
  expect(element.textContent).toBe('');
});

it('counts the subagents at work', async () => {
  await read([agent(1, 'running'), agent(2, 'completed')]);
  await render();

  expect(trigger()?.textContent).toBe('1 agent working');
  expect(trigger()?.getAttribute('aria-label')).toBe('1 agent working: show the subagents at work');

  await read([agent(1, 'running'), agent(2, 'queued'), agent(3, 'running')]);

  expect(trigger()?.textContent).toBe('3 agents working');
});

it('lists each one at work with what it is doing, and drops those that end', async () => {
  await read([agent(1, 'running', 'Queue migration'), agent(2, 'queued', 'Docs pass')]);
  await render();
  await open();

  expect(document.querySelector('.session-badge-title')?.textContent).toBe('Subagents at work');
  expect(rows().map((row) => row.textContent)).toEqual([
    expect.stringContaining('Queue migration'),
    expect.stringContaining('Docs pass'),
  ]);
  expect(rows()[0]?.textContent).toContain('Thinking');
  expect(rows()[1]?.textContent).toContain('Waiting to start');
  expect(rows()[0]?.textContent).toMatch(/\d+:\d{2}/);

  await read([agent(1, 'completed', 'Queue migration'), agent(2, 'running', 'Docs pass')]);

  expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining('Docs pass')]);
  expect(trigger()?.textContent).toBe('1 agent working');

  await read([agent(1, 'completed', 'Queue migration'), agent(2, 'completed', 'Docs pass')]);

  expect(trigger()).toBeNull();
  expect(rows()).toEqual([]);
});

it('opens a subagent in the Inspector, and closes the list', async () => {
  const working = agent(2, 'running', 'Docs pass');
  await read([agent(1, 'running'), working]);
  await render();
  await open();

  await act(async () => rows()[1]?.click());

  expect(useCrew.getState().following).toBe(working.runId);
  expect(useCrew.getState().opened).toBe(true);
  expect(useCrew.getState().opener).toBe(trigger());
  expect(rows()).toEqual([]);
});

it('never shows another conversation’s subagents', async () => {
  await read([agent(1, 'running')], 'elsewhere');
  await render('session');

  expect(trigger()).toBeNull();

  await render('elsewhere');

  expect(trigger()?.textContent).toBe('1 agent working');
});

it('goes when the store moves to another conversation while it is on screen', async () => {
  await read([agent(1, 'running')]);
  await render('session');
  await open();

  expect(rows()).toHaveLength(1);

  // The owner opened another conversation, whose History now shows its own agents.
  await read([agent(2, 'running'), agent(3, 'running')], 'elsewhere');

  expect(trigger()).toBeNull();
  expect(rows()).toEqual([]);

  await read([agent(1, 'running')], 'session');

  expect(trigger()?.textContent).toBe('1 agent working');
});

it('goes when its conversation is left, and only then', async () => {
  await read([agent(1, 'running')]);
  await render('session');

  await act(async () => useCrew.getState().leave('elsewhere'));

  expect(trigger()?.textContent).toBe('1 agent working');

  await act(async () => useCrew.getState().leave('session'));

  expect(trigger()).toBeNull();
});
