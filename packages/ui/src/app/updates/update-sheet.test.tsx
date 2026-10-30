import { MotionGlobalConfig } from 'motion/react';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppUpdate, type AppUpdateRelease, openUpdates, useAppUpdate } from './app-update';
import { AppUpdates, UpdateBadge } from './app-updates';
import { UpdateSheet } from './update-sheet';

const release: AppUpdateRelease = {
  version: '1.2.0',
  summary: 'Agents can share a conversation.',
  notes: '### Chats\n\n* **Shared:** two agents answer in one chat.',
  url: 'https://github.com/example/jian/releases/tag/v1.2.0',
  newLine: false,
};

// happy-dom's Web Animations reject when cancelled; the states are under test, not their motion.
MotionGlobalConfig.skipAnimations = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useAppUpdate.setState({ update: undefined, open: false, checkOnOpen: false });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = (node: ReactNode) => act(async () => root.render(node));
const text = () => document.body.textContent ?? '';
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);

function sheet(update: AppUpdate | undefined, handlers = { onCheck: vi.fn(), onInstall: vi.fn() }) {
  return render(<UpdateSheet open onOpenChange={() => {}} update={update} {...handlers} />);
}

describe('the update sheet', () => {
  it('says it is checking until the host answers', async () => {
    await sheet(undefined);
    expect(text()).toContain('Checking for updates…');
  });

  it('says a build from source has nothing to follow', async () => {
    await sheet({ status: 'unavailable', version: '0.0.0-dev' });
    expect(text()).toContain('Updates come with the installed app');
    expect(button('Try again')).toBeUndefined();
  });

  it('says when this is the latest release, and can check again', async () => {
    const onCheck = vi.fn();
    await sheet(
      { status: 'latest', version: '1.1.0', checkedAt: Date.now() },
      { onCheck, onInstall: vi.fn() },
    );
    expect(text()).toContain('Jian is up to date');
    expect(text()).toContain('Checked just now');
    await act(async () => button('Check again')?.click());
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it('shows a download as it goes, with what the release brings', async () => {
    await sheet({
      status: 'downloading',
      version: '1.1.0',
      release,
      progress: { percent: 40, transferred: 40_000_000, total: 100_000_000, bytesPerSecond: 0 },
    });
    expect(text()).toContain('Jian 1.2.0 is available');
    expect(text()).toContain('40.0 MB of 100 MB');
    expect(text()).toContain('Agents can share a conversation.');
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '40',
    );
    expect(button('Restart to update')).toBeUndefined();
  });

  it('offers to restart once the release is ready', async () => {
    const onInstall = vi.fn();
    await sheet({ status: 'ready', version: '1.1.0', release }, { onCheck: vi.fn(), onInstall });
    expect(text()).toContain('Jian 1.2.0 is ready');
    await act(async () => button('Restart to update')?.click());
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it('warns that gateways must follow a release on another line', async () => {
    await sheet({ status: 'ready', version: '1.1.0', release: { ...release, newLine: true } });
    expect(text()).toContain('Jian 1.2 works with gateways on 1.2');
  });

  it('sends a Linux package to the release page', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    await sheet({ status: 'manual', version: '1.1.0', release });
    await act(async () => button('Download')?.click());
    expect(opened).toHaveBeenCalledWith(release.url, '_blank', 'noopener');
    opened.mockRestore();
  });

  it.each([
    ['offline', 'Couldn’t reach GitHub'],
    ['signature', 'The update didn’t pass verification'],
    ['missing', 'This release is still being published'],
    ['read-only', 'Move Jian to Applications to update'],
    ['unknown', 'Couldn’t check for updates'],
  ] as const)('explains a failure: %s', async (failure, title) => {
    const onCheck = vi.fn();
    await sheet(
      { status: 'failed', version: '1.1.0', failure, detail: 'sha512 checksum mismatch' },
      { onCheck, onInstall: vi.fn() },
    );
    expect(text()).toContain(title);
    await act(async () => button('Try again')?.click());
    expect(onCheck).toHaveBeenCalledTimes(1);
  });
});

/** A host the test drives: it answers checks and reports changes when told. */
function fakeHost(initial: AppUpdate) {
  let listener: ((update: AppUpdate) => void) | undefined;
  const fake = {
    state: vi.fn(async () => initial),
    check: vi.fn(
      async (): Promise<AppUpdate> => ({ status: 'available', version: '1.1.0', release }),
    ),
    install: vi.fn(),
    onChanged: (next: (update: AppUpdate) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    report: (update: AppUpdate) => act(async () => listener?.(update)),
  };
  return fake;
}

describe('the app’s updates', () => {
  it('checks when opened to check, and follows the download after', async () => {
    const updates = fakeHost({ status: 'idle', version: '1.1.0' });
    await render(<AppUpdates host={updates} />);
    expect(updates.check).not.toHaveBeenCalled();

    await act(async () => openUpdates({ check: true }));
    expect(updates.check).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Jian 1.2.0 is available');

    await updates.report({ status: 'ready', version: '1.1.0', release });
    await act(async () => button('Restart to update')?.click());
    expect(updates.install).toHaveBeenCalledTimes(1);
  });

  it('shows what is there without checking when the status bar opens it', async () => {
    const updates = fakeHost({ status: 'ready', version: '1.1.0', release });
    await render(
      <>
        <UpdateBadge />
        <AppUpdates host={updates} />
      </>,
    );
    await act(async () => button('Update ready')?.click());
    expect(useAppUpdate.getState().open).toBe(true);
    expect(text()).toContain('Jian 1.2.0 is ready');
    expect(updates.check).not.toHaveBeenCalled();
  });

  it('keeps the status bar quiet until a release is waiting', async () => {
    const updates = fakeHost({ status: 'latest', version: '1.1.0', checkedAt: Date.now() });
    await render(
      <>
        <UpdateBadge />
        <AppUpdates host={updates} />
      </>,
    );
    expect(button('Update ready')).toBeUndefined();
    await updates.report({
      status: 'downloading',
      version: '1.1.0',
      release,
      progress: { percent: 10, transferred: 1, total: 10, bytesPerSecond: 1 },
    });
    expect(button('Update ready')).toBeUndefined();
    await updates.report({ status: 'ready', version: '1.1.0', release });
    expect(button('Update ready')).toBeDefined();
  });
});
