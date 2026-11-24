import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { compareVersions, ReleaseNotes, readNotes } from '../src/releases/service.js';
import { releaseReads } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-release-admin-token-32-chars';
const admin = { authorization: `Bearer ${token}` };

const note = (version: string) => ({
  version,
  date: '2026-09-24',
  body: `What ${version} changed.`,
  prerelease: version.includes('-'),
});
const history = ['2.2.0', '2.2.0-rc.1', '2.1.0', '2.0.0'].map(note);

describe('the release notes the panel announces', () => {
  it('orders a candidate below the release it leads to', () => {
    expect(compareVersions('2.2.0-rc.1', '2.2.0')).toBeLessThan(0);
    expect(compareVersions('2.2.0-rc.2', '2.2.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
  });

  it('announces the running release once, then only what is newer, and never goes back', async () => {
    const { store } = await testServices();
    const at = (version: string) => new ReleaseNotes(store, version, history);

    // A first visit: the running release alone, not the history behind it.
    expect((await at('2.1.0').releases()).unseen.map((item) => item.version)).toEqual(['2.1.0']);
    await at('2.1.0').markSeen();
    expect((await at('2.1.0').releases()).unseen).toEqual([]);

    // An update to a stable release skips the candidate it never ran.
    const updated = await at('2.2.0').releases();

    expect(updated.unseen.map((item) => item.version)).toEqual(['2.2.0']);
    expect(updated.notes.map((item) => item.version)).toEqual(['2.2.0', '2.1.0', '2.0.0']);

    await at('2.2.0').markSeen();
    // A tab still on the older build closes late: the newer mark stands.
    await at('2.1.0').markSeen();
    expect((await at('2.2.0').releases()).unseen).toEqual([]);
  });

  it('offers the newest release to read on a build with no version, and announces nothing', async () => {
    const { store } = await testServices();

    // The newest stable one, with a candidate ahead of it left out.
    const ahead = [note('2.3.0-rc.1'), ...history];
    expect(await new ReleaseNotes(store, undefined, ahead).releases()).toEqual({
      notes: [note('2.2.0')],
      unseen: [],
      updates: [],
      behind: 0,
    });
    expect((await new ReleaseNotes(store, '0.0.0-dev', history).releases()).unseen).toEqual([]);
  });

  it('announces the relaunch even after an earlier release was marked read', async () => {
    const { store } = await testServices();
    const welcome = note('0.1.0');

    await store.db.insert(releaseReads).values({ scope: 'owner', version: '2.5.0' });
    const relaunched = new ReleaseNotes(store, '0.1.0', [welcome]);

    expect((await relaunched.releases()).unseen).toEqual([welcome]);
    await relaunched.markSeen();
    expect((await relaunched.releases()).unseen).toEqual([]);
    expect(
      (await store.db.select().from(releaseReads)).map((row) => [row.scope, row.version]),
    ).toEqual(
      expect.arrayContaining([
        ['owner', '2.5.0'],
        ['owner-relaunch', '0.1.0'],
      ]),
    );
  });

  it('reports newer public releases while respecting the running release channel', async () => {
    const { store } = await testServices();
    const fetcher = async () =>
      new Response(
        JSON.stringify([
          { tag_name: 'v2.3.0', body: 'Stable', published_at: '2026-09-30T00:00:00Z' },
          {
            tag_name: 'v2.2.0-rc.2',
            body: 'Candidate',
            prerelease: true,
            published_at: '2026-09-29T00:00:00Z',
          },
        ]),
        { status: 200 },
      );

    const stable = await new ReleaseNotes(store, '2.1.0', [], fetcher).releases();
    expect(stable).toMatchObject({ behind: 1 });
    expect(stable.updates.map((item) => item.version)).toEqual(['2.3.0']);

    const candidate = await new ReleaseNotes(store, '2.2.0-rc.1', [], fetcher).releases();
    expect(candidate.updates.map((item) => item.version)).toEqual(['2.3.0', '2.2.0-rc.2']);
  });

  it('reads GitHub again when asked, and keeps what it said through a refused read', async () => {
    const { store } = await testServices();
    const release = (tag: string) => ({
      tag_name: tag,
      body: 'Notes',
      published_at: '2026-11-24T00:00:00Z',
    });
    const answers: Response[] = [
      Response.json([release('v2.1.0')]),
      Response.json([release('v2.2.0'), release('v2.1.0')]),
      new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      new Response('{}', { status: 502 }),
    ];
    let reads = 0;
    const fetcher = (async () => {
      reads += 1;
      const answer = answers.shift();
      if (!answer) throw new TypeError('fetch failed');
      return answer;
    }) as typeof fetch;
    const notes = new ReleaseNotes(store, '2.0.0', [], fetcher);
    const newest = async (fresh?: boolean) => (await notes.releases(fresh)).updates[0]?.version;

    expect(await newest()).toBe('2.1.0');
    const checkedAt = notes.lastCheck().checkedAt;
    expect(checkedAt).toMatch(/^\d{4}-/);
    // Kept: a page load does not ask GitHub again.
    expect(await newest()).toBe('2.1.0');
    expect(reads).toBe(1);

    // A release just went out: a check reads it at once.
    expect(await newest(true)).toBe('2.2.0');
    expect(reads).toBe(2);
    expect(notes.lastCheck().error).toBeUndefined();

    // GitHub refuses: the release it listed stays, and the reason is said.
    expect(await newest(true)).toBe('2.2.0');
    expect(notes.lastCheck().error).toMatch(/hourly limit/);
    expect(await newest(true)).toBe('2.2.0');
    expect(notes.lastCheck().error).toBe('GitHub answered HTTP 502');
    expect(await newest(true)).toBe('2.2.0');
    expect(notes.lastCheck()).toMatchObject({ error: 'GitHub could not be reached' });
    expect(notes.lastCheck().checkedAt).toBeDefined();
  });

  it("serves a note's pictures to the owner, and nothing outside their folder", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jian-release-media-'));
    mkdirSync(join(directory, 'media'));
    writeFileSync(join(directory, 'media', 'picker.png'), 'synthetic picture');
    writeFileSync(join(directory, 'secret.png'), 'outside the folder');
    writeFileSync(join(directory, 'media', 'note.txt'), 'not a picture');
    const services = await testServices();
    const app = createApp({
      ...services,
      releases: new ReleaseNotes(
        services.store,
        '2.1.0',
        history,
        undefined,
        pathToFileURL(`${directory}/`),
      ),
      token,
      logger: false,
    });
    const read = (file: string, headers = admin) =>
      app.inject({ url: `/v1/releases/media/${file}`, headers });

    try {
      expect((await read('picker.png', {} as typeof admin)).statusCode).toBe(401);

      const picture = await read('picker.png');
      expect(picture.statusCode).toBe(200);
      expect(picture.json()).toMatchObject({
        file: 'picker.png',
        mimeType: 'image/png',
        bytes: 17,
        data: Buffer.from('synthetic picture').toString('base64'),
      });

      for (const refused of ['..%2Fsecret.png', '%2E%2E%2Fsecret.png', 'note.txt', 'gone.png']) {
        expect((await read(refused)).statusCode).toBe(404);
      }
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('is read and marked only by the owner', async () => {
    const services = await testServices();
    const app = createApp({
      ...services,
      releases: new ReleaseNotes(services.store, '2.1.0', history),
      token,
      logger: false,
    });

    try {
      expect((await app.inject({ url: '/v1/releases' })).statusCode).toBe(401);

      const read = await app.inject({ url: '/v1/releases', headers: admin });

      expect(read.json()).toMatchObject({ version: '2.1.0', unseen: [{ version: '2.1.0' }] });

      const seen = await app.inject({ method: 'POST', url: '/v1/releases/seen', headers: admin });

      expect(seen.json()).toMatchObject({ version: '2.1.0', unseen: [] });
    } finally {
      await app.close();
    }
  });
});

describe('notes as a checkout leaves them', () => {
  it('reads a note written with CRLF, and leaves out one it cannot read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jian-notes-'));
    try {
      writeFileSync(
        join(directory, '1.0.0.md'),
        '---\r\ndate: 2026-10-01\r\nsummary: The first.\r\n---\r\n\r\n### Added\r\n\r\n* A thing.\r\n',
      );
      writeFileSync(join(directory, '1.1.0.md'), '---\ndate: 2026-10-20\n---\n\n* Another.\n');
      writeFileSync(join(directory, '1.2.0.md'), 'No front matter here.\n');

      const notes = readNotes(pathToFileURL(`${directory}/`));

      expect(notes.map((note) => note.version)).toEqual(['1.1.0', '1.0.0']);
      expect(notes[1]).toMatchObject({ date: '2026-10-01', summary: 'The first.' });
      expect(notes[1]?.body).toBe('### Added\n\n* A thing.');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
