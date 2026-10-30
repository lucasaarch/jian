import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi, RunApproval, RunQuestion } from '../../lib/api';
import { History } from './history';

vi.mock('../../lib/events', () => ({ subscribe: () => () => undefined }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const approval: RunApproval = {
  id: '00000000-0000-4000-8000-0000000000a1',
  toolCallId: 'call-1',
  toolName: 'run_command',
  kind: 'machine',
  title: 'Delete 12 archived projects and their build history',
  detail: 'Frees 4.2 GB. Active projects are untouched and this cannot be undone.',
  confirmLabel: 'Delete 12 projects',
  request: '{"command":"rm -rf archive/"}',
  askedAt: '2026-10-29T10:00:00.000Z',
};

const message = (content: string) => ({
  id: 'message',
  profileId: 'profile',
  sessionId: 'session',
  runId: 'run',
  role: 'assistant' as const,
  content,
  createdAt: '2026-10-29T10:00:00.000Z',
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
});

async function show(
  timeline: {
    approval?: RunApproval;
    question?: { id: string; prompt: string; choices?: string[]; askedAt: string };
  },
  content: string,
  chat?: string,
) {
  const decideApproval = vi.fn(async () => ({}));
  const answerRun = vi.fn(async () => ({}));
  const api = {
    messages: async () => [message(content)],
    activities: async () => [],
    timeline: async () => [{ runId: 'run', steps: [], ...timeline }],
    decideApproval,
    answerRun,
  } as unknown as GatewayApi;

  await act(async () =>
    root.render(<History api={api} profileId="profile" sessionId="session" chat={chat} />),
  );
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find((item) => item.textContent === name);

  return { decideApproval, answerRun, button };
}

it('asks for approval in the conversation, and approving or rejecting decides that run', async () => {
  const { decideApproval, button } = await show(
    { approval },
    `Waiting for approval: ${approval.title}`,
  );

  // The card takes the place of the line the gateway wrote for it.
  expect(element.textContent).toContain('Needs approval');
  expect(element.textContent).not.toContain('Waiting for approval:');
  expect(element.textContent).not.toContain('rm -rf');
  await act(async () => button('Show request')?.click());
  expect(element.querySelector('.decision-request pre')?.textContent).toContain('rm -rf archive/');

  await act(async () => button('Delete 12 projects')?.click());
  expect(decideApproval).toHaveBeenCalledWith('profile', 'run', 'approve');
  await act(async () => button('Reject')?.click());
  expect(decideApproval).toHaveBeenLastCalledWith('profile', 'run', 'reject');
});

it('shows a decided approval without buttons, saying how it went', async () => {
  const { button } = await show(
    { approval: { ...approval, decision: 'rejected', decidedBy: 'contact', note: 'not today' } },
    `Waiting for approval: ${approval.title}`,
    'WhatsApp',
  );

  expect(element.textContent).toContain('Rejected');
  expect(element.textContent).toContain('Declined in WhatsApp: not today');
  expect(button('Reject')).toBeUndefined();
  expect(button('Delete 12 projects')).toBeUndefined();
});

it('leaves a chat’s pending approval and question to the chat', async () => {
  const pending = await show({ approval }, `Waiting for approval: ${approval.title}`, 'Telegram');

  expect(element.textContent).toContain('Waiting for an answer in Telegram.');
  expect(pending.button('Reject')).toBeUndefined();

  const question = {
    id: 'q',
    prompt: 'Which branch?',
    choices: ['main', 'dev'],
    askedAt: approval.askedAt,
  };
  const asked = await show({ question }, 'Which branch?\n\n1. main\n2. dev', 'WhatsApp');

  expect(element.textContent).toContain('Question');
  expect(element.textContent).toContain('Waiting for an answer in WhatsApp.');
  expect(asked.button('main')).toBeUndefined();
});

it('answers a question from its choices in the panel’s own chat', async () => {
  const question = {
    id: 'q',
    prompt: 'Which branch?',
    choices: ['main', 'dev'],
    askedAt: approval.askedAt,
  };
  const { answerRun, button } = await show({ question }, 'Which branch?\n\n1. main\n2. dev');

  await act(async () => button('dev')?.click());
  expect(answerRun).toHaveBeenCalledWith('profile', 'run', 'dev');
});

it('finds the card by the run that asked, whatever the gateway wrote for it', async () => {
  await show({ approval }, 'Pending: the agent wants to clean up storage.');

  expect(element.textContent).toContain('Needs approval');
  expect(element.textContent).not.toContain('Pending: the agent wants');
});

/** A conversation of several turns, each run's timeline beside it. */
async function conversation(
  timelines: Array<{ runId: string; approval?: RunApproval; question?: RunQuestion }>,
  said: Array<{
    runId: string;
    role: 'user' | 'assistant';
    content: string;
    purpose?: 'answer' | 'resume';
  }>,
) {
  const answerRun = vi.fn(async () => ({}));
  const api = {
    messages: async () =>
      said.map((item, index) => ({
        ...message(item.content),
        id: `message-${index}`,
        runId: item.runId,
        role: item.role,
        ...(item.purpose ? { purpose: item.purpose } : {}),
        createdAt: `2026-10-29T10:0${index}:00.000Z`,
      })),
    activities: async () => [],
    timeline: async () => timelines.map((item) => ({ steps: [], ...item })),
    answerRun,
  } as unknown as GatewayApi;

  await act(async () => root.render(<History api={api} profileId="profile" sessionId="session" />));
  return { answerRun };
}

const asked: RunQuestion = {
  id: '00000000-0000-4000-8000-0000000000b1',
  prompt: 'Which provider should I wire first?',
  choices: ['Gemini Live', 'OpenAI Realtime, with the longer setup the docs describe'],
  recommended: 'Gemini Live',
  askedAt: '2026-10-29T10:00:00.000Z',
};

it('lists the choices as rows, the recommended one marked, and a row answers', async () => {
  const { answerRun } = await conversation(
    [{ runId: 'run', question: asked }],
    [{ runId: 'run', role: 'assistant', content: 'Which provider should I wire first?' }],
  );

  const rows = [...element.querySelectorAll('.decision-options li')];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.querySelector('.decision-recommended')?.textContent).toBe('Recommended');
  expect(rows[1]?.querySelector('.decision-recommended')).toBeNull();

  const second = rows[1]?.querySelector('button');
  await act(async () => second?.click());
  expect(answerRun).toHaveBeenCalledWith('profile', 'run', asked.choices?.[1]);
});

it('keeps an answered question with its answer marked, and hides the turns around it', async () => {
  await conversation(
    [
      {
        runId: 'run',
        question: {
          ...asked,
          answer: 'Gemini Live',
          answeredAt: asked.askedAt,
          answeredBy: 'owner',
        },
      },
      { runId: 'next' },
    ],
    [
      { runId: 'run', role: 'assistant', content: 'Which provider should I wire first?' },
      { runId: 'run', role: 'user', content: 'Gemini Live', purpose: 'answer' },
      {
        runId: 'next',
        role: 'user',
        content: 'The owner answered the mid-run question. Continue the work with this answer.',
        purpose: 'resume',
      },
      { runId: 'next', role: 'assistant', content: 'Wiring Gemini Live now.' },
    ],
  );

  expect(element.querySelectorAll('.decision-options button')).toHaveLength(0);
  expect(element.querySelector('[data-chosen]')?.textContent).toContain('Gemini Live');
  expect(element.textContent).not.toContain('by you');
  expect(element.textContent).not.toContain('The owner answered');
  // The answer lives in the card, not in a bubble of its own.
  expect([...element.querySelectorAll('.chat-line.mine')].map((line) => line.textContent)).toEqual(
    [],
  );
  expect(element.textContent).toContain('Wiring Gemini Live now.');
});

it('quotes an answer that was written rather than picked', async () => {
  await conversation(
    [
      {
        runId: 'run',
        question: { ...asked, answer: 'Neither, wait for Monday', answeredBy: 'owner' },
      },
    ],
    [{ runId: 'run', role: 'assistant', content: 'Which provider should I wire first?' }],
  );

  expect(element.querySelector('[data-chosen]')).toBeNull();
  expect(element.querySelector('.decision-answer')?.textContent).toContain(
    'Neither, wait for Monday',
  );
});

it('leaves the note after an approval out of the conversation', async () => {
  await conversation(
    [
      {
        runId: 'run',
        approval: {
          ...approval,
          decision: 'approved',
          decidedBy: 'owner',
          decidedAt: approval.askedAt,
        },
      },
      { runId: 'next' },
    ],
    [
      { runId: 'run', role: 'assistant', content: `Waiting for approval: ${approval.title}` },
      {
        runId: 'next',
        role: 'user',
        content: 'The owner approved the action you asked to take. It has already run.',
        purpose: 'resume',
      },
      { runId: 'next', role: 'assistant', content: 'Cleaned up.' },
    ],
  );

  expect(element.textContent).toContain('Approved');
  expect(element.textContent).not.toContain('The owner approved');
  expect(element.textContent).toContain('Cleaned up.');
});
