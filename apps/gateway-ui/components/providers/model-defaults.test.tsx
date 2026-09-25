import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SectionProps } from '../props';
import { ModelDefaults } from './model-defaults';

// A saved choice reloads the workspace; here there is none to reload.
vi.mock('../../lib/workspace', () => ({ useWorkspace: () => ({ refresh: async () => {} }) }));

const model = (id: string, output: string[] = ['text']) => ({
  id,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  reasoningEfforts: [],
  inputModalities: ['text'],
  outputModalities: output,
  known: true,
});

/** Opens one activity's dialog and its Model menu, with every provider below connected. */
async function modelMenu(activity: string, apiKey: boolean) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // happy-dom has no modal dialogs; the component only needs the calls to exist.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const props = {
    profile: { id: 'profile' },
    data: {
      providers: [
        { id: 'google', name: 'Gemini', kind: 'google' },
        { id: 'anthropic', name: 'Anthropic', kind: 'anthropic' },
        { id: 'codex', name: 'OpenAI', kind: 'openai', authMode: 'codex' },
        ...(apiKey ? [{ id: 'openai', name: 'OpenAI', kind: 'openai', authMode: 'api' }] : []),
      ],
      providerModels: {
        google: { models: [model('gemini-3-pro'), model('gemini-3-pro-image', ['image'])] },
        anthropic: { models: [model('claude-sonnet-5')] },
      },
      modelDefaults: {},
    },
    api: {},
    mutate: async () => {},
    busy: false,
  } as unknown as SectionProps;
  await act(async () => root.render(<ModelDefaults {...props} />));
  // Each activity's selects live in its own dialog, opened from its card.
  const card = Array.from(element.querySelectorAll('.model-card')).find(
    (item) => item.querySelector('h2')?.textContent === activity,
  );
  const configure = card?.querySelector('button');
  if (!configure) throw new Error(`${activity} card missing`);
  await act(async () => configure.click());
  const labels = Array.from(element.querySelectorAll('label'));
  expect(labels.map((item) => item.textContent)).not.toContain('Provider');
  const label = labels.find((item) => item.textContent === 'Model');
  const trigger = document.getElementById(label?.htmlFor ?? '') as HTMLButtonElement | null;
  if (!trigger) throw new Error('Model selector missing');
  await act(async () => trigger.click());
  return {
    element,
    options: () =>
      Array.from(document.querySelectorAll('[role="option"]')).map((item) => item.textContent),
    close: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

it('lists the models of every connected provider in one menu, each naming its provider', async () => {
  const view = await modelMenu('Conversations', false);
  try {
    expect(view.options()).toEqual(
      expect.arrayContaining(['Automatic', 'gemini-3-proGemini', 'claude-sonnet-5Anthropic']),
    );
    expect(view.options()).not.toContain('gemini-3-pro-imageGemini');
  } finally {
    await view.close();
  }
});

it('offers image generation only where it works, and explains the missing OpenAI API key', async () => {
  const view = await modelMenu('Image generation', false);
  try {
    expect(view.options()).toEqual(['Automatic', 'gemini-3-pro-imageGemini', 'Type an id…Gemini']);
    expect(view.element.textContent).toContain('ChatGPT login does not authorize image generation');
  } finally {
    await view.close();
  }
});

it('offers the configured OpenAI API key for image generation', async () => {
  const view = await modelMenu('Image generation', true);
  try {
    expect(view.options()).toContain('Type an id…OpenAI · API key');
  } finally {
    await view.close();
  }
});

it('shows one incoming audio setting for voice notes and audio files', async () => {
  const view = await modelMenu('Image generation', false);
  try {
    const headings = Array.from(view.element.querySelectorAll('h2')).map(
      (item) => item.textContent,
    );
    expect(headings).toContain('Incoming audio');
    expect(headings).not.toContain('Speech to text');
    expect(headings).not.toContain('Audio analysis');
    expect(headings).toContain('Text to speech');
  } finally {
    await view.close();
  }
});
