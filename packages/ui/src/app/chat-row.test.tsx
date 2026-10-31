import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatRow, RenameDialog } from './chat-row';

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(
  rename?: (title: string) => Promise<boolean>,
  pinned?: boolean,
  pin?: () => void,
) {
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
        pinned={pinned}
        pin={pin}
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

async function dialog(rename: (title: string) => Promise<boolean>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const close = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(<RenameDialog open onOpenChange={close} name="Old title" rename={rename} />),
  );
  return close;
}

const field = () => document.querySelector<HTMLInputElement>('[role="dialog"] input');

const type = (value: string) =>
  act(async () => {
    const input = field();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });

const save = () =>
  act(async () => {
    document
      .querySelector('[role="dialog"] form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

it('renames a chat from its menu, in a dialog that opens on its name', async () => {
  const rename = vi.fn(async () => true);
  const view = await render(rename);

  const items = await view.menu();
  await act(async () => items.find((item) => item.textContent === 'Rename')?.click());
  expect(field()?.value).toBe('Old title');

  await type('  Release checks  ');
  await save();
  expect(rename).toHaveBeenCalledExactlyOnceWith('Release checks');
});

it('stays open when the name could not be saved', async () => {
  const close = await dialog(async () => false);
  await type('Release checks');
  await save();
  expect(close).not.toHaveBeenCalled();
});

it('asks nothing of the gateway when the name did not change', async () => {
  const rename = vi.fn(async () => true);
  const close = await dialog(rename);
  await save();
  expect(rename).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});

it('deletes from its menu, and offers no rename where the name is not the chat’s own', async () => {
  const view = await render();

  const items = await view.menu();
  expect(items.map((item) => item.textContent)).toEqual(['Delete']);
  await act(async () => items[0]?.click());

  expect(view.remove).toHaveBeenCalledOnce();
});

it('replaces time with working, then unread until the conversation is opened', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('ul');
  document.body.append(host);
  const root = createRoot(host);
  const row = (working: boolean, unread: boolean, selected = false) => (
    <ChatRow
      name="Release notes"
      at="2026-10-31T08:00:00Z"
      selected={selected}
      working={working}
      unread={unread}
      open={() => {}}
      remove={() => {}}
    />
  );
  try {
    act(() => root.render(row(true, false)));
    expect(host.querySelector('[role="status"][aria-label="Working"] svg')).not.toBeNull();
    expect(host.querySelector('time')).toBeNull();
    act(() => root.render(row(true, true)));
    expect(host.querySelector('[aria-label="Working"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Unread"]')).toBeNull();
    act(() => root.render(row(false, true)));
    expect(host.querySelector('[aria-label="Working"]')).toBeNull();
    expect(host.querySelector('[aria-label="Unread"]')).not.toBeNull();
    expect(host.querySelector('time')).toBeNull();
    act(() => root.render(row(false, false, true)));
    expect(host.querySelector('[aria-label="Unread"]')).toBeNull();
    expect(host.querySelector('time')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each([false, true])('offers the pin action for pinned=%s', async (pinned) => {
  const pin = vi.fn();
  const view = await render(undefined, pinned, pin);
  const items = await view.menu();
  const item = items.find((entry) => entry.textContent === (pinned ? 'Unpin' : 'Pin'));
  expect(item).toBeDefined();
  await act(async () => item?.click());
  expect(pin).toHaveBeenCalledOnce();
});
