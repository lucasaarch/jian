import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_EVERY_MS,
  type FoundRelease,
  fromSource,
  RETRY_MS,
  UpdateFlow,
  type Updater,
} from '../src/main/updates/flow';
import { readNotes } from '../src/main/updates/notes';
import type { DownloadProgress, UpdateState } from '../src/shared/updates';

/** An updater whose answers the test gives, one call at a time, with no network. */
class FakeUpdater implements Updater {
  inPlace = true;
  checks = 0;
  installed = false;
  private answers: Array<() => Promise<FoundRelease | null>> = [];
  private downloads: Array<{
    progress: (progress: DownloadProgress) => void;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  answer(found: FoundRelease | null | Error): void {
    this.answers.push(() =>
      found instanceof Error ? Promise.reject(found) : Promise.resolve(found),
    );
  }

  check(): Promise<FoundRelease | null> {
    this.checks += 1;
    const next = this.answers.shift();
    return next ? next() : Promise.resolve(null);
  }

  download(progress: (progress: DownloadProgress) => void): Promise<void> {
    return new Promise((resolve, reject) => this.downloads.push({ progress, resolve, reject }));
  }

  get downloading() {
    const download = this.downloads.at(-1);
    if (!download) throw new Error('No download started.');
    return download;
  }

  install(): void {
    this.installed = true;
  }
}

const NOTE = [
  'Agents can share a conversation.',
  '',
  '### Chats',
  '',
  '* **Shared:** two agents answer in one chat.',
].join('\n');

function flowWith(updater: Updater | null, version = '1.1.0') {
  const seen: UpdateState[] = [];
  const steps: string[] = [];
  const recover = vi.fn();
  const flow = new UpdateFlow({
    updater,
    version,
    releaseUrl: (next) => `https://github.com/example/jian/releases/tag/v${next}`,
    changed: (state) => seen.push(state),
    prepare: async () => {
      steps.push('prepare');
    },
    recover,
  });
  return { flow, seen, steps, recover, statuses: () => seen.map((state) => state.status) };
}

/** Lets the promises the flow chains settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('a build from source', () => {
  it('is any unpackaged app, and a package of the development version', () => {
    expect(fromSource(false, '1.2.0')).toBe(true);
    expect(fromSource(true, '0.0.0-dev')).toBe(true);
    expect(fromSource(true, '1.2.0')).toBe(false);
  });

  it('never checks, on start or when asked, and says why', async () => {
    vi.useFakeTimers();
    const { flow, seen } = flowWith(null, '0.0.0-dev');
    flow.start();
    expect(await flow.check()).toEqual({ status: 'unavailable', version: '0.0.0-dev' });
    expect(vi.getTimerCount()).toBe(0);
    expect(seen).toEqual([]);
    vi.useRealTimers();
  });
});

describe('an installed app', () => {
  let updater: FakeUpdater;
  beforeEach(() => {
    updater = new FakeUpdater();
  });

  it('starts idle and says when it is the latest release', async () => {
    const { flow, statuses } = flowWith(updater);
    expect(flow.state().status).toBe('idle');
    updater.answer(null);
    const answer = await flow.check();
    expect(answer).toMatchObject({ status: 'latest', version: '1.1.0' });
    expect(statuses()).toEqual(['checking', 'latest']);
  });

  it('downloads a newer release in the background, then installs it when asked', async () => {
    const { flow, statuses, steps } = flowWith(updater);
    updater.answer({ version: '1.1.1', notes: NOTE });

    const answer = await flow.check();
    expect(answer).toMatchObject({ status: 'available', release: { version: '1.1.1' } });

    updater.downloading.progress({
      percent: 40,
      transferred: 40_000_000,
      total: 100_000_000,
      bytesPerSecond: 2_000_000,
    });
    expect(flow.state()).toMatchObject({ status: 'downloading', progress: { percent: 40 } });

    updater.downloading.resolve();
    await settle();
    expect(flow.state()).toMatchObject({ status: 'ready', release: { version: '1.1.1' } });
    expect(statuses()).toEqual(['checking', 'available', 'downloading', 'ready']);

    await flow.install();
    // What must stop cleanly is stopped before the installer takes over.
    expect(steps).toEqual(['prepare']);
    expect(updater.installed).toBe(true);
  });

  it('describes the release from its note', async () => {
    const { flow } = flowWith(updater);
    updater.answer({ version: '1.2.0', notes: NOTE });
    const answer = await flow.check();
    expect(answer).toMatchObject({
      status: 'available',
      release: {
        version: '1.2.0',
        summary: 'Agents can share a conversation.',
        notes: '### Chats\n\n* **Shared:** two agents answer in one chat.',
        url: 'https://github.com/example/jian/releases/tag/v1.2.0',
        // 1.1 to 1.2: every gateway the app connects to must move too.
        newLine: true,
      },
    });
  });

  it('does not take a patch release for a new line', async () => {
    const { flow } = flowWith(updater);
    updater.answer({ version: '1.1.4' });
    expect(await flow.check()).toMatchObject({ release: { newLine: false } });
  });

  it('asks GitHub once for checks made at the same time, and not again while downloading', async () => {
    const { flow } = flowWith(updater);
    updater.answer({ version: '1.1.1' });
    const [first, second] = await Promise.all([flow.check(), flow.check()]);
    expect(first).toEqual(second);
    expect(await flow.check()).toMatchObject({ status: 'available' });
    expect(updater.checks).toBe(1);
  });

  it('keeps a ready release when a late progress event arrives', async () => {
    const { flow } = flowWith(updater);
    updater.answer({ version: '1.1.1' });
    await flow.check();
    const { progress, resolve } = updater.downloading;
    resolve();
    await settle();
    progress({ percent: 99, transferred: 99, total: 100, bytesPerSecond: 1 });
    expect(flow.state().status).toBe('ready');
  });

  it('installs nothing unless a release is ready', async () => {
    const { flow, steps } = flowWith(updater);
    await flow.install();
    expect(steps).toEqual([]);
    expect(updater.installed).toBe(false);
  });

  it('starts again as it was when the installer cannot start', async () => {
    const { flow, recover } = flowWith(updater);
    updater.answer({ version: '1.1.1' });
    await flow.check();
    updater.downloading.resolve();
    await settle();
    updater.install = () => {
      throw new Error('spawn EACCES');
    };
    await flow.install();
    expect(flow.state()).toMatchObject({ status: 'failed', failure: 'unknown' });
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('points a Linux package to the release instead of downloading', async () => {
    updater.inPlace = false;
    const { flow } = flowWith(updater);
    updater.answer({ version: '1.1.1' });
    expect(await flow.check()).toMatchObject({ status: 'manual', release: { version: '1.1.1' } });
    expect(() => updater.downloading).toThrow();
  });
});

describe('a failed update', () => {
  let updater: FakeUpdater;
  beforeEach(() => {
    updater = new FakeUpdater();
  });

  const failing = (message: string, code?: string) =>
    Object.assign(new Error(message), code ? { code } : {});

  it('says when GitHub could not be reached', async () => {
    const { flow } = flowWith(updater);
    updater.answer(failing('getaddrinfo ENOTFOUND github.com', 'ENOTFOUND'));
    expect(await flow.check()).toMatchObject({ status: 'failed', failure: 'offline' });
    updater.answer(failing('net::ERR_INTERNET_DISCONNECTED'));
    expect(await flow.check()).toMatchObject({ failure: 'offline' });
  });

  it('says when the release has no update files for this system yet', async () => {
    const { flow } = flowWith(updater);
    updater.answer(
      failing(
        'Cannot find latest-mac.yml in the latest release artifacts (https://github.com/example/jian/releases/download/v1.1.1/latest-mac.yml): HttpError: 404\n"method: GET"',
        'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
      ),
    );
    const answer = await flow.check();
    expect(answer).toMatchObject({ status: 'failed', failure: 'missing' });
    // Only the first line of what the updater said, not the request it dumps after.
    expect(answer.status === 'failed' && answer.detail).not.toContain('method');
  });

  it('throws away a download that fails its checksum, keeping the release it was for', async () => {
    const { flow } = flowWith(updater);
    updater.answer({ version: '1.1.1' });
    await flow.check();
    updater.downloading.reject(failing('sha512 checksum mismatch, expected abc, got def'));
    await settle();
    expect(flow.state()).toMatchObject({
      status: 'failed',
      failure: 'signature',
      release: { version: '1.1.1' },
    });
  });

  it('says when macOS refuses a bundle whose code signature does not match', async () => {
    const { flow } = flowWith(updater);
    updater.answer({ version: '1.1.1' });
    await flow.check();
    updater.downloading.reject(
      failing(
        'Code signature at URL file:///tmp/Jian.app/ did not pass validation: code failed to satisfy specified code requirement(s)',
      ),
    );
    await settle();
    expect(flow.state()).toMatchObject({ failure: 'signature' });
  });

  it('says when the app runs from its disk image', async () => {
    const { flow } = flowWith(updater);
    updater.answer({ version: '1.1.1' });
    await flow.check();
    updater.downloading.reject(failing('Cannot update while running on a read-only volume.'));
    await settle();
    expect(flow.state()).toMatchObject({ failure: 'read-only' });
  });

  it('can be tried again', async () => {
    const { flow } = flowWith(updater);
    updater.answer(failing('net::ERR_NAME_NOT_RESOLVED'));
    await flow.check();
    updater.answer(null);
    expect(await flow.check()).toMatchObject({ status: 'latest' });
  });
});

describe('checking on its own', () => {
  let updater: FakeUpdater;
  beforeEach(() => {
    vi.useFakeTimers();
    updater = new FakeUpdater();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks on start, then every six hours', async () => {
    const { flow } = flowWith(updater);
    flow.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 1);
    expect(updater.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checks).toBe(2);
    flow.stop();
  });

  it('looks again sooner after GitHub could not be reached', async () => {
    const { flow } = flowWith(updater);
    updater.answer(Object.assign(new Error('offline'), { code: 'ENOTFOUND' }));
    flow.start();
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(updater.checks).toBe(2);
    flow.stop();
  });

  it('stops looking once a release is ready', async () => {
    const { flow } = flowWith(updater);
    updater.answer({ version: '1.1.1' });
    flow.start();
    await vi.advanceTimersByTimeAsync(0);
    updater.downloading.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.state().status).toBe('ready');
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(updater.checks).toBe(1);
    flow.stop();
  });
});

describe('a release note', () => {
  it('opens with its summary, the rest beneath', () => {
    expect(readNotes(NOTE)).toEqual({
      summary: 'Agents can share a conversation.',
      notes: '### Chats\n\n* **Shared:** two agents answer in one chat.',
    });
  });

  it('has no summary when it opens with a heading', () => {
    expect(readNotes('### Fixes\n\n* A crash.')).toEqual({
      summary: '',
      notes: '### Fixes\n\n* A crash.',
    });
  });

  it('reads GitHub’s HTML back into Markdown', () => {
    const html =
      '<p>Agents can share a conversation &amp; more.</p>\n<h3>Chats</h3>\n<ul>\n<li><strong>Shared:</strong> two agents, <code>one</code> chat.</li>\n</ul>';
    expect(readNotes(html)).toEqual({
      summary: 'Agents can share a conversation & more.',
      notes: '### Chats\n\n* **Shared:** two agents, `one` chat.',
    });
  });

  it('takes the newest of several, and survives having none', () => {
    expect(readNotes([{ version: '1.2.0', note: 'Newest.' }]).summary).toBe('Newest.');
    expect(readNotes(null)).toEqual({ summary: '', notes: '' });
  });
});
