import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GatewayAnswer } from '../lib/api/result';
import { CODE_RELOADED, ReadFailed } from './failed';

let failure: Error | undefined;
const Reads = () => {
  if (failure) throw failure;
  return <p>Conversations</p>;
};

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  onlineManager.setOnline(true);
});

async function show(error: Error) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  failure = error;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ReadFailed>
          <Reads />
        </ReadFailed>
      </QueryClientProvider>,
    ),
  );
  return host;
}

it('blames the gateway when it answered with a failure, or did not answer', async () => {
  expect((await show(new GatewayAnswer('Unauthorized'))).textContent).toContain(
    'The gateway did not answer',
  );
  expect((await show(new TypeError('Failed to fetch'))).textContent).toContain(
    'The gateway did not answer',
  );
});

it('does not blame the gateway for a problem in the app', async () => {
  for (const bug of [new Error('useAgentId outside an agent route'), new TypeError('x is null')]) {
    const host = await show(bug);
    expect(host.textContent).not.toContain('The gateway did not answer');
    expect(host.textContent).toContain('not in your gateway');
    expect(host.textContent).toContain(bug.message);
  }
});

it('recovers by itself when the code that failed is replaced', async () => {
  const host = await show(new Error('A slip while editing'));
  expect(host.textContent).not.toContain('Conversations');

  failure = undefined;
  await act(async () => window.dispatchEvent(new Event(CODE_RELOADED)));

  expect(host.textContent).toContain('Conversations');
});

it('recovers by itself when the gateway answers again, as after a restart', async () => {
  onlineManager.setOnline(false);
  const host = await show(new TypeError('Failed to fetch'));

  failure = undefined;
  await act(async () => onlineManager.setOnline(true));

  expect(host.textContent).toContain('Conversations');
});

it('shows the failure again if it still stands', async () => {
  const host = await show(new Error('Still broken'));

  await act(async () => window.dispatchEvent(new Event(CODE_RELOADED)));

  expect(host.textContent).toContain('Still broken');
});
