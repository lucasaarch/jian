import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ModelSelection } from '@/lib/api';
import { type ModelEntry, ModelMenu } from './model-menu';

const models: ModelEntry[] = [
  {
    providerId: 'p',
    modelId: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    provider: 'Anthropic',
    efforts: ['low', 'medium', 'high'],
    fast: false,
  },
  {
    providerId: 'p',
    modelId: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    provider: 'Anthropic',
    efforts: ['low', 'medium', 'high'],
    fast: true,
  },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function open(value: ModelSelection, onChange = vi.fn()) {
  await act(async () =>
    root.render(<ModelMenu label="Model" models={models} value={value} onChange={onChange} />),
  );
  const trigger = container.querySelector('button') as HTMLButtonElement;
  await act(async () => trigger.click());
  const hover = async (name: string) => {
    const row = [
      ...document.querySelectorAll<HTMLButtonElement>('.model-menu-list .model-option'),
    ].find((item) => item.textContent?.includes(name));
    await act(async () => row?.focus());
  };
  return { trigger, onChange, hover };
}

it('reads the model and its effort in the trigger', async () => {
  const { trigger } = await open({
    providerId: 'p',
    modelId: 'claude-opus-5-5',
    reasoningEffort: 'low',
    fast: true,
  });

  expect(trigger.textContent).toBe('Claude Opus 5.5Low Fast');
});

it('offers Fast only on a model that takes it, and switching it on picks that model', async () => {
  const { onChange, hover } = await open({
    providerId: 'p',
    modelId: 'claude-sonnet-5-5',
    reasoningEffort: 'medium',
  });

  expect(document.querySelector('[role="switch"]')).toBeNull();

  await hover('Claude Opus 5.5');
  const fast = document.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(fast).not.toBeNull();
  await act(async () => fast?.click());

  // The effort chosen for the previous model carries over when the new one has it.
  expect(onChange).toHaveBeenCalledWith({
    providerId: 'p',
    modelId: 'claude-opus-5-5',
    reasoningEffort: 'medium',
    fast: true,
  });
});

it('an effort picked beside another model switches to that model with it', async () => {
  const { onChange, hover } = await open({
    providerId: 'p',
    modelId: 'claude-sonnet-5-5',
    reasoningEffort: 'low',
  });

  await hover('Claude Opus 5.5');
  const high = [
    ...document.querySelectorAll<HTMLButtonElement>('.model-menu-options .model-option'),
  ].find((item) => item.textContent === 'High');
  await act(async () => high?.click());

  expect(onChange).toHaveBeenCalledWith({
    providerId: 'p',
    modelId: 'claude-opus-5-5',
    reasoningEffort: 'high',
  });
});
