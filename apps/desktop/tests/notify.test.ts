import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notice } from '../src/main/gateways/monitor';
import { looksAt, type WindowView } from '../src/main/looking';
import type { OpenTarget, Showing } from '../src/shared/bridge';

/** What the system shows: the notifications the app handed it and has not taken back. */
type Shown = { options: { id: string; title: string; body: string }; click(): void };
const screen = vi.hoisted(() => ({ on: [] as Shown[] }));

vi.mock('electron', () => {
  class Notification {
    static isSupported = () => true;
    private readonly listeners = new Map<string, () => void>();
    constructor(readonly options: { id: string; title: string; body: string }) {}
    on(event: string, listener: () => void) {
      this.listeners.set(event, listener);
      return this;
    }
    show() {
      screen.on.push(this);
    }
    close() {
      screen.on = screen.on.filter((shown) => shown !== this);
      this.listeners.get('close')?.();
    }
    click() {
      this.listeners.get('click')?.();
    }
  }
  return { Notification };
});

const { Notifier } = await import('../src/main/notify');

const notice = (sessionId: string, text: string, gatewayId = 'local'): Notice => ({
  gatewayId,
  profileId: 'agent-1',
  profileName: 'Ada',
  sessionId,
  title: `Chat ${sessionId}`,
  text,
  asks: false,
});

const front: WindowView = { visible: true, minimized: false, focused: true };
const onChat = (sessionId: string, gatewayId = 'local'): Showing => ({
  gatewayId,
  chat: { profileId: 'agent-1', sessionId },
});

describe('whether the owner is reading a conversation', () => {
  const chat = notice('a', '');

  it('is reading only the chat open in a window that is up and in front', () => {
    expect(looksAt(front, onChat('a'), chat)).toBe(true);
  });

  it('is not, on another chat, another agent or another gateway', () => {
    expect(looksAt(front, onChat('b'), chat)).toBe(false);
    expect(
      looksAt(front, { gatewayId: 'local', chat: { profileId: 'agent-2', sessionId: 'a' } }, chat),
    ).toBe(false);
    expect(looksAt(front, onChat('a', 'gw-1'), chat)).toBe(false);
    expect(looksAt(front, { gatewayId: 'local' }, chat)).toBe(false);
  });

  it('is not, with the window minimized, behind another app or hidden in the tray', () => {
    expect(looksAt({ ...front, minimized: true }, onChat('a'), chat)).toBe(false);
    expect(looksAt({ ...front, focused: false }, onChat('a'), chat)).toBe(false);
    expect(looksAt({ ...front, visible: false, focused: false }, onChat('a'), chat)).toBe(false);
    expect(looksAt(undefined, onChat('a'), chat)).toBe(false);
  });
});

describe('the system notifications', () => {
  beforeEach(() => {
    screen.on = [];
  });

  it('shows one per chat, the newer replacing the older', () => {
    const notifier = new Notifier(() => {});
    notifier.show(notice('a', 'First draft is ready.'), '', false);
    notifier.show(notice('b', 'Tests pass.'), '', false);
    notifier.show(notice('a', 'Second draft is ready.'), '', false);
    expect(screen.on.map((shown) => shown.options.body)).toEqual([
      'Tests pass.',
      'Second draft is ready.',
    ]);
  });

  it('names the gateway beside the agent only when there are several', () => {
    const notifier = new Notifier(() => {});
    notifier.show(notice('a', 'Done.'), 'jian.example.com', false);
    notifier.show(notice('b', 'Done.'), 'jian.example.com', true);
    expect(screen.on.map((shown) => shown.options.title)).toEqual([
      'Ada',
      'Ada · jian.example.com',
    ]);
  });

  it('takes a chat’s notification away once it is opened, and leads to the chat on a click', () => {
    const opened: OpenTarget[] = [];
    const notifier = new Notifier((target) => opened.push(target));
    notifier.show(notice('a', 'Done.', 'gw-1'), '', false);
    notifier.show(notice('b', 'Done.'), '', false);
    notifier.dismiss({ gatewayId: 'local', profileId: 'agent-1', sessionId: 'b' });
    expect(screen.on.map((shown) => shown.options.id)).toEqual(['gw-1/agent-1/a']);

    screen.on[0]?.click();
    expect(opened).toEqual([{ gatewayId: 'gw-1', path: '/agents/agent-1/sessions/a' }]);
  });

  it('takes every one away when notifications are turned off', () => {
    const notifier = new Notifier(() => {});
    notifier.show(notice('a', 'Done.'), '', false);
    notifier.show(notice('b', 'Done.'), '', false);
    notifier.dismissAll();
    expect(screen.on).toEqual([]);
  });
});
