import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

it('does nothing until the agent is named as it is written', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const run = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete Atlas?"
        phrase="Atlas"
        action="Delete agent"
        run={run}
      >
        It goes with everything it has.
      </ConfirmDialog>,
    ),
  );
  const input = document.querySelector<HTMLInputElement>('form input');
  const button = [...document.querySelectorAll('button')].find(
    (item) => item.textContent === 'Delete agent',
  );
  const type = (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

  await type('atlas');
  expect(button?.disabled).toBe(true);
  await act(async () => button?.click());
  expect(run).not.toHaveBeenCalled();

  await type('Atlas');
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  expect(run).toHaveBeenCalledTimes(1);

  await act(async () => root.unmount());
  host.remove();
});
