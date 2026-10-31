import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GatewayApi, Subagent } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';
import { CrewDrawer } from './crew-drawer';

it('stops the followed worker without closing its inspector or duplicating the completion status', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const agent = {
    runId: 'child',
    sessionId: 'child-session',
    name: 'Researcher',
    role: 'execute',
    status: 'running',
    tier: 'light',
    tierBy: 'agent',
    createdAt: '2026-10-31T10:00:00Z',
    updatedAt: '2026-10-31T10:00:03Z',
  } as Subagent;
  const cancelRun = vi.fn(async () => ({
    id: 'child',
    status: 'cancelled',
    updatedAt: '2026-10-31T10:00:04Z',
  }));
  const api = {
    messages: async () => [],
    timeline: async () => [],
    cancelRun,
  } as unknown as GatewayApi;
  useCrew.setState({ sessionId: 'parent-session', agents: [agent], following: agent.runId });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<CrewDrawer api={api} profileId="profile" />));
    expect(element.textContent).not.toContain('Chosen by');
    const stop = element.querySelector<HTMLButtonElement>('[aria-label="Stop agent"]');
    expect(stop).not.toBeNull();
    await act(async () => stop?.click());
    expect(cancelRun).toHaveBeenCalledWith('profile', 'child');
    expect(element.querySelector('.crew-drawer')).not.toBeNull();
    expect(element.querySelector('[aria-label="Stop agent"]')).toBeNull();
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Stopped after');
    expect(element.textContent).not.toContain('Finished in');
    expect(useCrew.getState().agents[0]?.status).toBe('cancelled');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    useCrew.getState().leave('parent-session');
  }
});

it('uses the chat message layout with the profile avatar above the tool activity', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const avatar = 'data:image/png;base64,c3ludGhldGlj';
  const agent = {
    runId: 'review',
    sessionId: 'review-session',
    name: 'Review task',
    role: 'review',
    status: 'completed',
    createdAt: '2026-10-31T10:00:00Z',
    updatedAt: '2026-10-31T10:00:03Z',
  } as Subagent;
  const api = {
    messages: async () => [
      {
        id: 'reply',
        runId: 'review',
        sessionId: 'review-session',
        profileId: 'profile',
        role: 'assistant',
        content: 'The review is complete.',
        createdAt: agent.updatedAt,
      },
    ],
    timeline: async () => [
      {
        runId: 'review',
        steps: [
          {
            toolCallId: 'read',
            toolName: 'read_file',
            status: 'done',
            startedAt: '2026-10-31T10:00:01Z',
            finishedAt: '2026-10-31T10:00:02Z',
          },
        ],
      },
    ],
  } as unknown as GatewayApi;
  useCrew.setState({ sessionId: 'parent', agents: [agent], following: agent.runId });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<CrewDrawer api={api} profileId="profile" profile={{ name: 'Mia', avatar }} />),
    );
    const message = host.querySelector('.chat-line.theirs');
    const author = message?.querySelector('.chat-author-row');
    const activity = message?.querySelector('.thought-line');
    expect(author?.textContent).toContain('Mia');
    expect(author?.querySelector('img')?.getAttribute('src')).toBe(avatar);
    expect(activity).not.toBeNull();
    expect(
      (author?.compareDocumentPosition(activity as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(host.querySelectorAll('.thought-line')).toHaveLength(1);
    expect(message?.querySelector('.chat-text')?.textContent).toBe('The review is complete.');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useCrew.getState().leave('parent');
  }
});
