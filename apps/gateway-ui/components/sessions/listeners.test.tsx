import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { GatewayApi, Subscription } from '../../lib/api';
import { SessionListeners } from './listeners';

const base: Subscription = {
  id: '11111111-1111-4111-8111-111111111111',
  profileId: '22222222-2222-4222-8222-222222222222',
  name: 'PR 53 Check',
  instruction: 'CI finished — continue.',
  sessionId: '33333333-3333-4333-8333-333333333333',
  source: 'github',
  filter: {
    owner: 'lucasaarch',
    repo: 'jian',
    events: ['check_suite.completed'],
    pullNumber: 53,
    checkName: 'Check',
    pollIntervalSeconds: 30,
  },
  enabled: true,
  createdBy: 'agent',
  nextPollAt: '2099-01-01T12:00:30.000Z',
  lastObservation: {
    pullState: 'open',
    merged: false,
    headSha: 'abc1234',
    checksCompleted: false,
  },
  expiresAt: '2099-01-01T13:00:00.000Z',
  createdAt: '2099-01-01T12:00:00.000Z',
  updatedAt: '2099-01-01T12:00:00.000Z',
};

it('lists active listeners for the open conversation', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const api = {
    subscriptions: async () => [
      base,
      {
        ...base,
        id: '44444444-4444-4444-8444-444444444444',
        sessionId: '55555555-5555-4555-8555-555555555555',
        name: 'Other chat',
      },
      {
        ...base,
        id: '66666666-6666-4666-8666-666666666666',
        name: 'Expired',
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
      {
        ...base,
        id: '77777777-7777-4777-8777-777777777777',
        name: 'Off',
        enabled: false,
      },
    ],
  } as Pick<GatewayApi, 'subscriptions'>;

  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SessionListeners
            api={api as GatewayApi}
            profileId={base.profileId}
            sessionId={base.sessionId}
          />
        </QueryClientProvider>,
      ),
    );
    // The cache tells its readers on the next tick.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(element.querySelector('.session-listeners')).not.toBeNull();
    expect(element.textContent).toContain('PR 53 Check');
    expect(element.textContent).toContain('lucasaarch/jian #53');
    expect(element.textContent).toContain('Open · checks pending');
    expect(element.textContent).toContain('Next poll');
    expect(element.textContent).toContain('Expires');
    expect(element.textContent).not.toContain('Other chat');
    expect(element.textContent).not.toContain('Expired');
    expect(element.textContent).not.toContain('Off');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('renders nothing when this conversation has no active listeners', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const api = {
    subscriptions: async () => [],
  } as Pick<GatewayApi, 'subscriptions'>;

  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SessionListeners
            api={api as GatewayApi}
            profileId={base.profileId}
            sessionId={base.sessionId}
          />
        </QueryClientProvider>,
      ),
    );
    // The cache tells its readers on the next tick.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(element.querySelector('.session-listeners')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
