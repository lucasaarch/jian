import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { keys } from '../../lib/query/keys';
import { MobilePage } from './mobile-page';

const api = vi.hoisted(() => ({
  devices: vi.fn(),
  createDevicePairing: vi.fn(),
  updateDevice: vi.fn(),
  revokeDevice: vi.fn(),
}));
vi.mock('../../lib/query/client', () => ({ panelApi: () => api }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} />,
}));

const phone = {
  id: '5b0e3f2a-1c4d-4e8b-9a6f-7d2c1e0b9a38',
  name: 'Harbor phone',
  platform: 'ios' as const,
  previews: false,
  push: true,
  createdAt: '2026-11-01T10:00:00Z',
  lastSeenAt: '2026-11-05T09:30:00Z',
};
const other = { ...phone, id: 'a7c1d9e2-3b4f-4a5c-8d6e-0f1a2b3c4d5e', name: 'Spare phone' };

const NOW = new Date('2026-11-06T12:00:00Z');
const pairing = (code: string, seconds = 300) => ({
  url: 'https://jian.example.test',
  code,
  expiresAt: new Date(NOW.getTime() + seconds * 1000).toISOString(),
});

let root: Root | undefined;
let client: QueryClient;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  for (const call of Object.values(api)) call.mockReset();
  api.devices.mockResolvedValue([]);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
});

async function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <MobilePage />
      </QueryClientProvider>,
    ),
  );
}

const button = (name: string) =>
  [...document.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
const click = (name: string) => act(async () => button(name)?.click());
const qr = () => document.querySelector('[data-testid="qr"]')?.getAttribute('data-value');

it('lists the paired phones and revokes one only after asking', async () => {
  api.devices.mockResolvedValue([phone]);
  api.revokeDevice.mockResolvedValue(undefined);
  await show();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Harbor phone'));
  expect(document.body.textContent).toContain('Last seen');

  await click('Revoke Harbor phone');
  expect(api.revokeDevice).not.toHaveBeenCalled();

  await click('Revoke phone');
  expect(api.revokeDevice).toHaveBeenCalledWith(phone.id);
});

it('turns previews on for one phone', async () => {
  api.devices.mockResolvedValue([phone]);
  api.updateDevice.mockResolvedValue({ ...phone, previews: true });
  await show();
  const toggle = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role="switch"]');
    if (!found) throw new Error('no switch');
    return found;
  });
  await act(async () => toggle.click());
  expect(api.updateDevice).toHaveBeenCalledWith(phone.id, { previews: true });
});

it("shows a QR of the gateway's address and code, and replaces an expired one", async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
  });
  vi.setSystemTime(NOW);
  api.createDevicePairing
    .mockResolvedValueOnce(pairing('c1', 60))
    .mockResolvedValueOnce(pairing('c2'));
  await show();
  await click('Pair a phone');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(qr()).toBe('jian://pair?url=https%3A%2F%2Fjian.example.test&code=c1');
  expect(document.body.textContent).toContain('Open Jian on your phone and scan this code.');

  await act(async () => {
    await vi.advanceTimersByTimeAsync(61_000);
  });
  expect(api.createDevicePairing).toHaveBeenCalledTimes(2);
  expect(qr()).toContain('code=c2');
});

it('says what to set when the gateway has no public address', async () => {
  api.createDevicePairing.mockRejectedValue(
    Object.assign(new Error('Set JIAN_PUBLIC_URL to pair a phone.'), { status: 409 }),
  );
  await show();
  await click('Pair a phone');
  await vi.waitFor(() => expect(document.body.textContent).toContain('Set JIAN_PUBLIC_URL'));
  expect(qr()).toBeUndefined();
});

it('closes the pairing once the new phone appears', async () => {
  api.devices.mockResolvedValue([phone]);
  api.createDevicePairing.mockResolvedValue(pairing('c1'));
  await show();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Harbor phone'));
  await click('Pair a phone');
  await vi.waitFor(() => expect(qr()).toContain('code=c1'));

  await act(async () => client.setQueryData(keys.devices, [phone, other]));

  await vi.waitFor(() => expect(qr()).toBeUndefined());
});
