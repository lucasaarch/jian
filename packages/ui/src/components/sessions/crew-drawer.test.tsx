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
