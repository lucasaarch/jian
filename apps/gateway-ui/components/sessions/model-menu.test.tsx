import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ModelSelection } from '@/lib/api';
import { EffortMenu, type ModelEntry, ModelMenu } from './model-menu';

const sonnet: ModelEntry = {
  providerId: 'p',
  modelId: 'claude-sonnet-5-5',
  name: 'Claude Sonnet 5.5',
  provider: 'Anthropic',
  efforts: ['low', 'medium', 'high'],
  fast: false,
};
const opus: ModelEntry = {
  ...sonnet,
  modelId: 'claude-opus-5-5',
  name: 'Claude Opus 5.5',
  fast: true,
};

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

const click = async (element?: Element | null) => {
  await act(async () => (element as HTMLElement | null)?.click());
};
const option = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.model-option')].find((item) =>
    item.textContent?.includes(text),
  );

it('a model chosen keeps the effort and speed it can, and drops what it cannot', async () => {
  const onChange = vi.fn();
  const value: ModelSelection = {
    providerId: 'p',
    modelId: 'claude-opus-5-5',
    reasoningEffort: 'high',
    fast: true,
  };
  await act(async () =>
    root.render(
      <ModelMenu label="Model" models={[sonnet, opus]} value={value} onChange={onChange} />,
    ),
  );

  await click(container.querySelector('button'));
  await click(option('Claude Sonnet 5.5'));

  // Sonnet has High but no Fast.
  expect(onChange).toHaveBeenCalledWith({
    providerId: 'p',
    modelId: 'claude-sonnet-5-5',
    reasoningEffort: 'high',
  });
});

it('offers Fast beside the efforts only on a model that takes it', async () => {
  const onChange = vi.fn();
  const value: ModelSelection = {
    providerId: 'p',
    modelId: 'claude-sonnet-5-5',
    reasoningEffort: 'low',
  };
  await act(async () =>
    root.render(<EffortMenu model={sonnet} value={value} onChange={onChange} />),
  );

  expect(container.querySelector('button')?.textContent).toBe('Low');
  await click(container.querySelector('button'));
  expect(document.querySelector('[role="switch"]')).toBeNull();
  await click(option('High'));
  expect(onChange).toHaveBeenCalledWith({ ...value, reasoningEffort: 'high' });

  await act(async () =>
    root.render(
      <EffortMenu model={opus} value={{ ...value, modelId: opus.modelId }} onChange={onChange} />,
    ),
  );
  await click(container.querySelector('button'));
  await click(document.querySelector('[role="switch"]'));
  expect(onChange).toHaveBeenLastCalledWith({ ...value, modelId: opus.modelId, fast: true });
});
