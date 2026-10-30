import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatRow } from './chat-row';

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(rename?: (title: string) => Promise<void>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const remove = vi.fn();
  const host = document.createElement('ul');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <ChatRow
        name="Old title"
        at="2026-10-30T10:00:00Z"
        selected={false}
        unread={false}
        working={false}
        open={() => {}}
        {...(rename ? { rename } : {})}
        remove={remove}
      />,
    ),
  );
  const menu = async () => {
    await act(async () =>
      host
        .querySelector('li')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 20 })),
    );
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  };
  return { host, remove, menu };
}

const type = (input: HTMLInputElement | null, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });

it('renames a chat from its menu, and keeps the name when Escape is pressed', async () => {
  const rename = vi.fn(async () => {});
  const view = await render(rename);

  const items = await view.menu();
  await act(async () => items.find((item) => item.textContent === 'Rename')?.click());
  const field = view.host.querySelector<HTMLInputElement>('input[aria-label="Chat name"]');
  await type(field, 'Release checks');
  await act(async () =>
    field?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(rename).toHaveBeenCalledExactlyOnceWith('Release checks');

  const again = await view.menu();
  await act(async () => again.find((item) => item.textContent === 'Rename')?.click());
  const second = view.host.querySelector<HTMLInputElement>('input[aria-label="Chat name"]');
  await type(second, 'Something else');
  await act(async () =>
    second?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(rename).toHaveBeenCalledTimes(1);
});

it('deletes from its menu, and offers no rename where the name is not the chat’s own', async () => {
  const view = await render();

  const items = await view.menu();
  expect(items.map((item) => item.textContent)).toEqual(['Delete']);
  await act(async () => items[0]?.click());

  expect(view.remove).toHaveBeenCalledOnce();
});
