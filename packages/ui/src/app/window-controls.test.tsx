import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WindowControls } from './window-controls';

it('calls each action with nothing: a context bridge cannot clone the click', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const actions = {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    onMaximized: () => () => {},
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(<WindowControls actions={actions} />));

  const press = (label: string) =>
    act(async () => element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click());
  await press('Minimize');
  await press('Maximize');
  await press('Close');

  expect(actions.minimize.mock.calls).toEqual([[]]);
  expect(actions.toggleMaximize.mock.calls).toEqual([[]]);
  expect(actions.close.mock.calls).toEqual([[]]);

  await act(async () => root.unmount());
  element.remove();
});
