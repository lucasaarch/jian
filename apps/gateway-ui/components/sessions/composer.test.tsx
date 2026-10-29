import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { startRecording } = vi.hoisted(() => ({ startRecording: vi.fn() }));

vi.mock('../../lib/recorder', () => ({
  useRecorder: () => ({ recording: false, seconds: 0, start: startRecording, cancel: vi.fn() }),
}));
vi.mock('../ui', () => ({ AudioPlayer: () => null }));

import { Composer } from './composer';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  startRecording.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('keeps voice-note recording and removes live call controls', async () => {
  await act(async () => {
    root.render(
      createElement(Composer, {
        name: 'Mia',
        upload: vi.fn(),
        send: vi.fn(),
        onSent: vi.fn(),
      }),
    );
  });

  const record = container.querySelector<HTMLButtonElement>('[aria-label="Record a voice note"]');
  expect(record).not.toBeNull();
  expect(container.querySelector('[aria-label="Start voice call"]')).toBeNull();
  expect(container.querySelector('[aria-label="End voice call"]')).toBeNull();

  await act(async () => record?.click());
  expect(startRecording).toHaveBeenCalledOnce();
});

it('offers a new project first and names each project by its repository slug', async () => {
  const onNewProject = vi.fn();
  const onProjectChange = vi.fn();
  await act(async () => {
    root.render(
      createElement(Composer, {
        name: 'Mia',
        upload: vi.fn(),
        send: vi.fn(),
        onSent: vi.fn(),
        projects: [
          {
            id: 'site',
            profileId: 'mia',
            name: 'Site',
            repositoryUrl: 'https://github.com/octo-example/site.git',
            createdAt: '2026-10-29T12:00:00Z',
          },
        ],
        onProjectChange,
        onNewProject,
      }),
    );
  });

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Project"]')?.click(),
  );
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((option) => option.textContent)).toEqual([
    'New Project',
    'No project',
    'Siteocto-example/site',
  ]);

  await act(async () => options[0]?.click());
  expect(onNewProject).toHaveBeenCalledOnce();
  expect(onProjectChange).not.toHaveBeenCalled();
});
