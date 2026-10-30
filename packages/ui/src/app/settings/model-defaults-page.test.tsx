import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Profile } from '../../lib/api';
import { AgentCache, type AgentSlices } from '../../test/agent';
import { ModelDefaultsPage } from './model-defaults-page';

const actions = vi.hoisted(() => ({ api: {} as GatewayApi }));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({ api: actions.api, mutate: async () => true, busy: false }),
  // A saved choice reloads the workspace; here there is none to reload.
  useRefresh: () => async () => {},
}));

const model = (id: string, output: string[] = ['text']) => ({
  id,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  reasoningEfforts: [],
  inputModalities: ['text'],
  outputModalities: output,
  known: true,
});

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

it('saves the chosen conversation model for channels too, as one default', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const setModelDefaults = vi.fn(async () => ({}));
  actions.api = { setModelDefaults } as unknown as GatewayApi;
  const slices = {
    providers: [
      { id: 'google', name: 'Gemini', kind: 'google' },
      { id: 'anthropic', name: 'Anthropic', kind: 'anthropic' },
    ],
    providerModels: {
      google: { providerId: 'google', models: [model('gemini-3-pro')] },
      anthropic: { providerId: 'anthropic', models: [model('claude-sonnet-5')] },
    },
    modelDefaults: {
      conversation: { providerId: 'google', modelId: 'gemini-3-pro' },
      channel: { providerId: 'google', modelId: 'gemini-3-pro' },
    },
  } as unknown as AgentSlices;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={{ id: 'profile' } as Profile} slices={slices}>
        <ModelDefaultsPage />
      </AgentCache>,
    ),
  );

  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="Conversations & channels model"]',
  );
  await act(async () => trigger?.click());
  // The composer's own model menu: its models are buttons in a list.
  const option = [...document.querySelectorAll<HTMLElement>('.model-option')].find((item) =>
    item.textContent?.includes('claude-sonnet-5'),
  );
  await act(async () => option?.click());
  // A choice is saved at once, on the next turn of the event loop.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

  expect(setModelDefaults).toHaveBeenCalledWith(
    expect.objectContaining({
      conversation: { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
      channel: { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
    }),
  );
});

/** Opens one activity's model menu, with Gemini, which also draws, and Anthropic connected. */
async function menu(activity: string, modelDefaults: Record<string, unknown> = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const setModelDefaults = vi.fn(async () => ({}));
  actions.api = { setModelDefaults } as unknown as GatewayApi;
  const slices = {
    providers: [
      { id: 'google', name: 'Gemini', kind: 'google' },
      { id: 'anthropic', name: 'Anthropic', kind: 'anthropic' },
    ],
    providerModels: {
      google: {
        providerId: 'google',
        models: [model('gemini-3-pro'), model('gemini-3-pro-image', ['image'])],
      },
      anthropic: { providerId: 'anthropic', models: [model('claude-sonnet-5')] },
    },
    modelDefaults,
  } as unknown as AgentSlices;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={{ id: 'profile' } as Profile} slices={slices}>
        <ModelDefaultsPage />
      </AgentCache>,
    ),
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>(`[aria-label="${activity} model"]`)?.click(),
  );
  const options = () =>
    [...document.querySelectorAll('.model-option .model-option-name')].map(
      (item) => item.textContent,
    );
  return { options, setModelDefaults };
}

it('lists the models of every connected provider in one menu, and none that only draws', async () => {
  const { options } = await menu('Conversations & channels');

  expect(options()).toEqual(expect.arrayContaining(['gemini-3-pro', 'claude-sonnet-5']));
  expect(options()).not.toContain('gemini-3-pro-image');
  expect(options()).not.toContain('Disabled');
});

it('offers image generation only where it works, and saves Disabled as a state of its own', async () => {
  const { options, setModelDefaults } = await menu('Image generation', { image: null });

  expect(options()).toEqual(['Disabled', 'gemini-3-pro-image']);

  const disabled = [...document.querySelectorAll<HTMLElement>('.model-option')].find(
    (item) => item.textContent === 'Disabled',
  );
  await act(async () => disabled?.click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

  expect(setModelDefaults).toHaveBeenCalledWith(expect.objectContaining({ image: 'disabled' }));
});
