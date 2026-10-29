import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GatewayApi } from '@/lib/api';
import { MessageMedia } from './media';

const id = '0b6f8f2e-8a39-4d4f-9a51-7a1c2f7c3e10';
const profileId = '5d1c4a8e-2f0b-4f7e-8f6b-1e9d3a2c4b55';

it('shows an attachment that failed as unavailable, and fetches it again on Retry', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  const media = vi
    .fn<GatewayApi['media']>()
    .mockRejectedValueOnce(new Error('Synthetic outage'))
    .mockResolvedValueOnce({
      id,
      profileId,
      mimeType: 'application/pdf',
      name: 'Quote.pdf',
      bytes: 2048,
      createdAt: '2026-10-29T09:00:00.000Z',
      data: 'JVBERg==',
    });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MessageMedia api={{ media }} profileId={profileId} content={`[Attached media: ${id}]`} />
      </QueryClientProvider>,
    ),
  );

  await vi.waitFor(() => expect(element.textContent).toContain('Unavailable'));
  const retry = [...element.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Retry'),
  );
  await act(async () => retry?.click());

  expect(media).toHaveBeenCalledTimes(2);
  await vi.waitFor(() =>
    expect(element.querySelector('.file-card')?.textContent).toContain('Quote.pdf'),
  );
  expect(element.textContent).not.toContain('Unavailable');
  act(() => root.unmount());
});
