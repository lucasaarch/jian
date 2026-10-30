import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Channel, GatewayApi } from '../../lib/api';
import { ChannelPairing } from './channel-pairing';

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
});

const channel: Channel = {
  id: 'channel',
  profileId: 'profile',
  type: 'whatsapp',
  enabled: true,
  allowAllContacts: false,
  createdAt: '2026-10-30T12:00:00.000Z',
};

const show = (api: Partial<GatewayApi>) =>
  act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChannelPairing
          open
          onOpenChange={() => {}}
          channel={channel}
          profileId="profile"
          api={api as GatewayApi}
        />
      </QueryClientProvider>,
    );
  });

/** Lets the reads settle: the device's state, then the code it asks for. */
const settle = async (done: () => boolean) => {
  for (let tries = 0; tries < 50 && !done(); tries++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
};

const alert = () => document.querySelector('[role="alert"]')?.textContent;

it('says nothing went wrong when the gateway has no QR code ready', async () => {
  let refused = 0;
  await show({
    connection: async () => ({ status: 'qr' }) as Awaited<ReturnType<GatewayApi['connection']>>,
    qr: async () => {
      refused += 1;
      throw new Error('Something changed, or the session is busy. Refresh and try again.');
    },
  });
  await settle(() => refused > 0);
  // Past the refusal, for whatever it would have drawn.
  await settle(() => false);

  expect(alert()).toBeUndefined();
  expect(document.body.textContent).toContain('Waiting for the gateway to prepare a new QR code.');
});

it('says so when the connection itself cannot be read', async () => {
  await show({
    connection: async () => {
      throw new Error('The gateway could not be reached.');
    },
  });
  await settle(() => alert() !== undefined);

  expect(alert()).toBe('The gateway could not be reached.');
});
