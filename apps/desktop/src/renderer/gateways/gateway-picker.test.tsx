// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewaySummary } from '../../shared/bridge';

const reconnectGateway = vi.fn();
vi.mock('../desktop', () => ({ desktop: () => ({ reconnectGateway }) }));

import { GatewayPicker } from './gateway-picker';

const gateway = (status: GatewaySummary['status']): GatewaySummary =>
  ({
    id: 'harbor',
    name: 'harbor.example.test',
    local: false,
    url: 'https://harbor.example.test',
    status,
    unread: 0,
  }) as GatewaySummary;

let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  reconnectGateway.mockReset();
});

async function open(status: GatewaySummary['status'], select = vi.fn()) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const current = gateway(status);
  await act(async () =>
    root?.render(
      <GatewayPicker gateways={[current]} current={current} select={select} connect={vi.fn()} />,
    ),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Gateway"]')?.click());
  return select;
}

const reconnect = () =>
  document.querySelector<HTMLButtonElement>('[aria-label="Reconnect to harbor.example.test"]');

it('says why a gateway is not answering', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const current = { ...gateway('offline'), reason: 'No answer in 8 seconds' };
  await act(async () =>
    root?.render(
      <GatewayPicker gateways={[current]} current={current} select={vi.fn()} connect={vi.fn()} />,
    ),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Gateway"]')?.click());

  expect(document.body.textContent).toContain('No answer in 8 seconds');
});

it('offers to reconnect a gateway that is not answering, without choosing it again', async () => {
  const select = await open('offline');

  expect(document.body.textContent).not.toContain('Not answering');
  await act(async () => reconnect()?.click());

  expect(reconnectGateway).toHaveBeenCalledWith('harbor');
  expect(select).not.toHaveBeenCalled();
});

it('offers nothing to a gateway that answers, and still says why one refuses', async () => {
  await open('online');
  expect(reconnect()).toBeNull();
  await act(async () => root?.unmount());
  document.body.innerHTML = '';

  await open('unauthorized');
  expect(reconnect()).toBeNull();
  expect(document.body.textContent).toContain('Token refused');
});
