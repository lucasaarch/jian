import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { profile } from '../test/fixtures';
import { CreateAgent } from './create-agent';

const create = vi.hoisted(() => vi.fn());
vi.mock('../lib/query/client', () => ({ panelApi: () => ({ createProfile: create }) }));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) act(cleanup);
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

it('creates an agent with an editable preset summary and instructions', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  create.mockImplementation(async (input) => ({ ...profile, ...input }));
  const client = new QueryClient();
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const closed = vi.fn();
  cleanups.push(() => {
    root.unmount();
    client.clear();
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CreateAgent open onOpenChange={closed} />
      </QueryClientProvider>,
    ),
  );
  const button = (name: string) =>
    [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);
  await act(async () => button('Developer')?.click());
  const summary = document.querySelector<HTMLInputElement>('input[name="summary"]');
  const instructions = document.querySelector<HTMLTextAreaElement>('textarea[name="instructions"]');
  expect(summary?.value).toBe('From an idea or a bug to working software.');
  expect(instructions?.value).toContain('Investigate failures before proposing fixes');
  await act(async () => {
    const name = document.querySelector<HTMLInputElement>('input[name="name"]');
    for (const [input, value] of [
      [name, 'Mira'],
      [summary, 'Help maintain my TypeScript projects.'],
    ] as const) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await act(async () =>
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(create).toHaveBeenCalledWith({
    name: 'Mira',
    summary: 'Help maintain my TypeScript projects.',
    instructions: expect.stringContaining('Investigate failures before proposing fixes'),
  });
  expect(closed).toHaveBeenCalledWith(false);
});
