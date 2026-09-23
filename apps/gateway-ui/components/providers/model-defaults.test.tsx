import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SectionProps } from '../props';
import { ModelDefaults } from './model-defaults';

// A saved choice reloads the workspace; here there is none to reload.
vi.mock('../../lib/workspace', () => ({ useWorkspace: () => ({ refresh: async () => {} }) }));

async function imageProviders(apiKey: boolean) {
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
      providerModels: {},
      modelDefaults: {},
    },
    api: {},
    mutate: async () => {},
    busy: false,
  } as unknown as SectionProps;
  await act(async () => root.render(<ModelDefaults {...props} />));
  // Each activity's selects live in its own dialog, opened from its card.
  const card = Array.from(element.querySelectorAll('.model-card')).find(
    (item) => item.querySelector('h2')?.textContent === 'Image generation',
  );
  const configure = card?.querySelector('button');
  if (!configure) throw new Error('Image generation card missing');
  await act(async () => configure.click());
  const label = Array.from(element.querySelectorAll('label')).find(
    (item) => item.textContent === 'Provider',
  );
  const trigger = document.getElementById(label?.htmlFor ?? '') as HTMLButtonElement | null;
  if (!trigger) throw new Error('Image provider selector missing');
  await act(async () => trigger.click());
  return {
    element,
    close: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

it('offers only image-capable providers and explains the missing OpenAI API key', async () => {
  const view = await imageProviders(false);
  try {
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options.map((item) => item.textContent)).toEqual([
      'Automatic',
      'Gemini',
      'OpenAI · API key required',
    ]);
    expect(options.at(-1)?.getAttribute('aria-disabled')).toBe('true');
    expect(view.element.textContent).toContain('ChatGPT login does not authorize image generation');
  } finally {
    await view.close();
  }
});

it('offers the configured OpenAI API key for image generation', async () => {
  const view = await imageProviders(true);
  try {
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options.map((item) => item.textContent)).toEqual([
      'Automatic',
      'Gemini',
      'OpenAI · API key',
    ]);
    expect(options.at(-1)?.getAttribute('aria-disabled')).not.toBe('true');
  } finally {
    await view.close();
  }
});

it('shows one incoming audio setting for voice notes and audio files', async () => {
  const view = await imageProviders(false);
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
