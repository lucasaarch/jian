// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionWorktree } from '../../lib/api';
import { GatewayAnswer } from '../../lib/api/result';
import { useCrew } from '../../lib/stores/crew';
import { SessionWorktrees, useChangesFlag } from './session-worktrees';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const worktree = (name: string, extra: Partial<SessionWorktree> = {}): SessionWorktree => ({
  name,
  branch: `jian/${name}`,
  base: 'main',
  source: '/work/harbor',
  path: `/data/worktrees/harbor-1a2b3c4d/${name}`,
  place: 'gateway',
  ahead: 2,
  behind: 1,
  uncommitted: 3,
  pullRequest: false,
  ...extra,
});

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  toast.error.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  document.body.innerHTML = '';
});

const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

const show = async (
  worktrees: SessionWorktree[],
  { busy = false, api = {} }: { busy?: boolean; api?: Record<string, unknown> } = {},
) => {
  const onAction = vi.fn();
  const calls = {
    sessionWorktrees: vi.fn(async () => worktrees),
    mergeSessionWorktree: vi.fn(async () => ({})),
    updateSessionWorktree: vi.fn(async () => ({})),
    openWorktreePullRequest: vi.fn(async () => ({})),
    discardSessionWorktree: vi.fn(async () => undefined),
    ...api,
  };
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SessionWorktrees
          api={calls as never}
          profileId="profile"
          sessionId="session"
          busy={busy}
          onAction={onAction}
        />
      </QueryClientProvider>,
    ),
  );
  await tick();
  return { calls, onAction };
};

const trigger = () => element.querySelector<HTMLElement>('.session-badge-trigger');
const open = async () => {
  await act(async () => trigger()?.click());
  await tick();
};
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === label,
  );

it('shows no badge without worktrees', async () => {
  await show([]);

  expect(trigger()).toBeNull();
});

it('names a single worktree and counts several', async () => {
  await show([worktree('brave-otter')]);
  expect(trigger()?.textContent).toBe('brave-otter');
  expect(trigger()?.getAttribute('aria-label')).toBe('Worktree brave-otter: show its actions');

  await act(async () => root.unmount());
  root = createRoot(element);
  await show([worktree('brave-otter'), worktree('calm-heron')]);
  expect(trigger()?.textContent).toBe('2 worktrees');
});

it('says where each stands, leaving out what is zero', async () => {
  await show([
    worktree('brave-otter'),
    worktree('calm-heron', { ahead: 0, behind: 0, uncommitted: 4 }),
    worktree('keen-lynx', { ahead: null, behind: null, uncommitted: null }),
  ]);
  await open();

  const text = document.body.textContent ?? '';
  expect(text).toContain('jian/brave-otter → main');
  expect(text).toContain('2 ahead · 1 behind · 3 uncommitted');
  expect(text).toContain('4 uncommitted');
  expect(text).not.toContain('0 ahead');
  expect(text).toContain('Not reachable');
});

it('names the base in Merge and posts the merge action', async () => {
  const { calls, onAction } = await show([worktree('brave-otter', { base: 'release' })]);
  await open();

  expect(button('Merge into main')).toBeUndefined();
  await act(async () => button('Merge into release')?.click());
  await tick();

  expect(calls.mergeSessionWorktree).toHaveBeenCalledWith('profile', 'session', 'brave-otter');
  expect(onAction).toHaveBeenCalledTimes(1);
});

it('updates from the base', async () => {
  const { calls } = await show([worktree('brave-otter')]);
  await open();

  await act(async () => button('Update from main')?.click());
  await tick();

  expect(calls.updateSessionWorktree).toHaveBeenCalledWith(
    'profile',
    'session',
    'brave-otter',
    'merge',
  );
});

it('offers Open pull request only when it applies', async () => {
  const { calls } = await show([
    worktree('brave-otter'),
    worktree('calm-heron', { pullRequest: true }),
  ]);
  await open();

  const offered = [...document.querySelectorAll('button')].filter(
    (item) => item.textContent === 'Open pull request',
  );
  expect(offered).toHaveLength(1);
  await act(async () => offered[0]?.click());
  await tick();

  expect(calls.openWorktreePullRequest).toHaveBeenCalledWith('profile', 'session', 'calm-heron');
});

it('asks before discarding, then discards', async () => {
  const { calls, onAction } = await show([worktree('brave-otter')]);
  await open();

  expect(document.body.textContent).not.toContain('Discard once the agent has finished.');
  await act(async () => button('Discard')?.click());
  await tick();

  // The popover gives way, and the question stays until it is answered.
  expect(document.querySelector('.session-worktree')).toBeNull();
  expect(calls.discardSessionWorktree).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Discard brave-otter?');
  expect(document.body.textContent).toContain('Its 3 uncommitted files are lost');

  await act(async () => button('Discard worktree')?.click());
  await tick();

  expect(calls.discardSessionWorktree).toHaveBeenCalledWith('profile', 'session', 'brave-otter');
  expect(onAction).toHaveBeenCalledTimes(1);
});

it('disables Discard while the agent works, says why, and leaves the others', async () => {
  const { calls } = await show([worktree('brave-otter', { pullRequest: true })], { busy: true });
  await open();

  expect(document.body.textContent).toContain('Discard once the agent has finished.');

  expect(button('Discard')?.disabled).toBe(true);
  expect(button('Merge into main')?.disabled).toBe(false);
  expect(button('Update from main')?.disabled).toBe(false);
  expect(button('Open pull request')?.disabled).toBe(false);

  await act(async () => button('Merge into main')?.click());
  await tick();
  expect(calls.mergeSessionWorktree).toHaveBeenCalled();
});

it('says why an action was refused, without telling the agent it worked', async () => {
  const { onAction } = await show([worktree('brave-otter')], {
    api: {
      mergeSessionWorktree: vi.fn(async () => {
        throw new GatewayAnswer('The agent is answering this conversation.', 409);
      }),
    },
  });
  await open();

  await act(async () => button('Merge into main')?.click());
  await tick();

  expect(toast.error).toHaveBeenCalledWith('The agent is answering this conversation.');
  expect(onAction).not.toHaveBeenCalled();
});

it('warns that unread uncommitted files are lost', async () => {
  await show([worktree('brave-otter', { uncommitted: null })]);
  await open();
  await act(async () => button('Discard')?.click());
  await tick();

  expect(document.body.textContent).toContain('Any uncommitted files in it are lost.');
});

it('offers Changes again after switching between two conversations that both have a worktree', async () => {
  function Probe({ id }: { id: string }) {
    useChangesFlag(id, true);
    return null;
  }
  await act(async () => root.render(<Probe id="a" />));
  expect(useCrew.getState().worktrees).toBe(true);

  // The history of the one left resets the flag as it closes; the next one sets it again.
  await act(async () => {
    root.render(<Probe id="b" />);
    useCrew.setState({ worktrees: false });
  });
  expect(useCrew.getState().worktrees).toBe(true);
});

it('says the commits stay on the branch only when there are any', async () => {
  await show([worktree('brave-otter', { ahead: 0, uncommitted: 0 })]);
  await open();
  await act(async () => button('Discard')?.click());
  await tick();

  expect(document.body.textContent).toContain('Its folder is removed.');
  expect(document.body.textContent).not.toContain('Its commits stay on');

  await act(async () => root.unmount());
  root = createRoot(element);
  document.body.innerHTML = '';
  document.body.append(element);
  await show([worktree('calm-heron', { ahead: 2 })]);
  await open();
  await act(async () => button('Discard')?.click());
  await tick();

  expect(document.body.textContent).toContain('Its commits stay on jian/calm-heron.');
});
