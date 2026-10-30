import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAutoSave } from './auto-save';

function Field({ value, save }: { value: string; save: (value: string) => Promise<void> }) {
  useAutoSave(value, save, (next) => next.trim().length > 0);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(() => vi.useRealTimers());

async function mount(save: (value: string) => Promise<void>) {
  const host = document.createElement('div');
  const root = createRoot(host);
  const type = (value: string) => act(async () => root.render(<Field value={value} save={save} />));
  await type('Mia');
  return { type, close: () => act(async () => root.unmount()) };
}

it('saves once typing rests, with the newest value', async () => {
  const save = vi.fn(async () => {});
  const field = await mount(save);

  await field.type('Mia the');
  await field.type('Mia the assistant');
  expect(save).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1_000));

  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith('Mia the assistant');
  await field.close();
});

it('sends nothing the gateway would refuse', async () => {
  const save = vi.fn(async () => {});
  const field = await mount(save);

  await field.type('   ');
  await act(async () => vi.advanceTimersByTimeAsync(1_000));

  expect(save).not.toHaveBeenCalled();
  await field.close();
});

it('saves what was still waiting when the screen closes', async () => {
  const save = vi.fn(async () => {});
  const field = await mount(save);

  await field.type('Atlas');
  await field.close();
  await act(async () => vi.runAllTimersAsync());

  expect(save).toHaveBeenCalledWith('Atlas');
});
