import { randomUUID } from 'node:crypto';
import {
  artifactFolderSchema,
  artifactFoldersSchema,
  profileArtifactPageSchema,
} from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { sessionArtifacts, sessionArtifactVersions } from '../src/storage/schema.js';
import { projectRow } from './helpers/rows.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-admin-token-with-32-characters';
const headers = { authorization: `Bearer ${token}` };

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup() {
  // Each thing made a second after the one before, so "changed last first" has one answer.
  let now = Date.UTC(2026, 0, 1);
  const services = await testServices(() => {
    now += 1000;
    return now;
  });
  const app = createApp({
    ...services,
    token,
    logger: false,
    mode: 'server',
    publicUrl: 'https://jian.example.test',
  });
  apps.push(app);
  const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
  const plans = await services.sessions.createSession(owner.id, { channel: 'api', title: 'Plans' });
  const notes = await services.sessions.createSession(owner.id, { channel: 'api' });
  const theirs = await services.sessions.createSession(other.id, { channel: 'api' });
  const all = (query = '', profileId = owner.id, as: { authorization?: string } = headers) =>
    app.inject({ url: `/v1/profiles/${profileId}/session-artifacts${query}`, headers: as });
  const page = async (query = '', profileId = owner.id) =>
    profileArtifactPageSchema.parse((await all(query, profileId)).json());
  const one = (artifactId: string, sessionId: string, profileId = owner.id) =>
    `/v1/profiles/${profileId}/sessions/${sessionId}/artifacts/${artifactId}`;
  const phone = async () => {
    const pairing = await app.inject({ method: 'POST', url: '/v1/devices/pairings', headers });
    const paired = (
      await app.inject({
        method: 'POST',
        url: '/v1/devices/pair',
        payload: { code: pairing.json().code, name: 'Pixel', platform: 'android' },
      })
    ).json() as { token: string };

    return { authorization: `Bearer ${paired.token}` };
  };

  return { services, app, owner, other, plans, notes, theirs, all, page, one, phone };
}

describe('every Artifact of an agent', () => {
  it('lists its own across its conversations, and none of another agent’s', async () => {
    const { services, owner, other, plans, notes, theirs, all, page } = await setup();
    const roadmap = await services.artifacts.create(owner.id, plans.id, {
      title: 'Roadmap 100%',
      type: 'deck',
      slides: ['<html><body>One</body></html>'],
    });
    const memo = await services.artifacts.create(owner.id, notes.id, {
      title: 'Memo',
      type: 'markdown',
      content: '# Memo',
    });
    const secret = await services.artifacts.create(other.id, theirs.id, {
      title: 'Roadmap of another',
      type: 'markdown',
      content: '# Theirs',
    });

    expect((await all('', owner.id, {})).statusCode).toBe(401);
    expect((await all('', randomUUID())).statusCode).toBe(404);

    // The one changed last first, each with the name its conversation was given, if any.
    expect((await page()).items).toMatchObject([
      { id: memo.id, sessionId: notes.id, sessionTitle: null, version: 1 },
      { id: roadmap.id, sessionId: plans.id, sessionTitle: 'Plans', type: 'deck' },
    ]);
    expect((await page('', other.id)).items.map(({ id }) => id)).toEqual([secret.id]);

    // By words of the title, in any case, and by type. What is typed is never a pattern.
    expect((await page('?q=roadmap')).items.map(({ id }) => id)).toEqual([roadmap.id]);
    expect((await page('?q=100%25')).items.map(({ id }) => id)).toEqual([roadmap.id]);
    expect((await page('?q=_emo')).items).toEqual([]);
    expect((await page('?type=markdown')).items.map(({ id }) => id)).toEqual([memo.id]);
    expect((await page('?type=deck&q=memo')).items).toEqual([]);
    expect((await all('?type=spreadsheet')).statusCode).toBe(400);

    // A new version brings one to the top.
    await services.artifacts.revise(owner.id, plans.id, {
      artifactId: roadmap.id,
      slides: ['<html><body>Two</body></html>'],
    });
    expect((await page()).items.map(({ id }) => id)).toEqual([roadmap.id, memo.id]);

    // A page at a time, from the last one read, and never from another agent's.
    const first = await page('?limit=1');
    expect(first).toMatchObject({
      items: [{ id: roadmap.id, version: 2 }],
      nextCursor: roadmap.id,
    });
    expect(await page(`?limit=1&before=${first.nextCursor}`)).toMatchObject({
      items: [{ id: memo.id }],
      nextCursor: null,
    });
    expect((await all(`?before=${secret.id}`)).statusCode).toBe(404);
  });
});

describe('deleting an Artifact', () => {
  it('removes it for its owner, with its versions and its public link', async () => {
    const { services, app, owner, other, plans, notes, theirs, page, one } = await setup();
    const kept = await services.artifacts.create(owner.id, notes.id, {
      title: 'Kept',
      type: 'markdown',
      content: '# Kept',
    });
    const gone = await services.artifacts.create(owner.id, plans.id, {
      title: 'Gone',
      type: 'markdown',
      content: '# First',
    });
    await services.artifacts.revise(owner.id, plans.id, { artifactId: gone.id, content: '# Two' });
    const { publicPath } = await services.artifacts.update(owner.id, plans.id, gone.id, {
      visibility: 'public',
    });
    expect((await app.inject({ url: publicPath as string })).statusCode).toBe(200);

    // Not without the credential, and only through its own conversation and agent.
    const url = one(gone.id, plans.id);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(401);
    for (const elsewhere of [
      one(gone.id, notes.id),
      one(gone.id, theirs.id, other.id),
      one(gone.id, plans.id, other.id),
    ]) {
      expect((await app.inject({ method: 'DELETE', url: elsewhere, headers })).statusCode).toBe(
        404,
      );
    }
    expect((await app.inject({ url: publicPath as string })).statusCode).toBe(200);

    const deleted = await app.inject({ method: 'DELETE', url, headers });
    expect(deleted.statusCode).toBe(204);

    expect((await app.inject({ url: publicPath as string })).statusCode).toBe(404);
    expect((await app.inject({ url: `${url}/versions/1`, headers })).statusCode).toBe(404);
    expect((await page()).items.map(({ id }) => id)).toEqual([kept.id]);
    // Nothing of it is left, and what was beside it is whole.
    const versions = await services.store.db.select().from(sessionArtifactVersions);
    expect(versions.map(({ artifactId }) => artifactId)).toEqual([kept.id]);
    expect(await services.store.db.select().from(sessionArtifacts)).toHaveLength(1);
    // The agent that goes on to update it is told it is gone.
    await expect(
      services.artifacts.revise(owner.id, plans.id, { artifactId: gone.id, content: '# Three' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(404);
  });

  it('is refused to a paired phone, which only reads', async () => {
    const { services, app, owner, plans, all, one, phone } = await setup();
    const artifact = await services.artifacts.create(owner.id, plans.id, {
      title: 'Notes',
      type: 'markdown',
      content: '# Notes',
    });
    const device = await phone();

    expect((await all('', owner.id, device)).json()).toMatchObject({
      items: [{ id: artifact.id }],
    });
    const refused = await app.inject({
      method: 'DELETE',
      url: one(artifact.id, plans.id),
      headers: device,
    });
    expect(refused.statusCode).toBe(403);
    expect((await all()).json()).toMatchObject({ items: [{ id: artifact.id, version: 1 }] });
  });
});

describe('keeping Artifacts on the page', () => {
  const organising = async () => {
    const made = await setup();
    const { services, app, owner, plans, one } = made;
    const memo = await services.artifacts.create(owner.id, plans.id, {
      title: 'Memo',
      type: 'markdown',
      content: '# Memo',
    });
    const folders = (profileId = owner.id) => `/v1/profiles/${profileId}/artifact-folders`;
    const send = (
      method: 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: object,
      as: { authorization?: string } = headers,
    ) => app.inject({ method, url, headers: as, ...(payload ? { payload } : {}) });
    const folder = async (name: string, profileId = owner.id) =>
      artifactFolderSchema.parse((await send('POST', folders(profileId), { name })).json());
    const kept = async (profileId = owner.id) =>
      artifactFoldersSchema.parse((await app.inject({ url: folders(profileId), headers })).json());

    return { ...made, memo, folders, send, folder, kept, at: one(memo.id, plans.id) };
  };

  it('pins, renames and duplicates one with no new version, for its own agent only', async () => {
    const { services, owner, other, plans, notes, theirs, memo, send, page, one, at } =
      await organising();
    const deck = await services.artifacts.create(owner.id, notes.id, {
      title: 'Deck',
      type: 'deck',
      slides: ['<html><body>One</body></html>'],
    });

    // Not without the credential, and only through its own conversation and agent.
    expect((await send('PATCH', at, { pinned: true }, {})).statusCode).toBe(401);
    for (const elsewhere of [
      one(memo.id, notes.id),
      one(memo.id, theirs.id, other.id),
      one(memo.id, plans.id, other.id),
    ]) {
      expect((await send('PATCH', elsewhere, { pinned: true })).statusCode).toBe(404);
      expect((await send('POST', `${elsewhere}/duplicate`)).statusCode).toBe(404);
    }
    expect((await send('PATCH', at, {})).statusCode).toBe(400);

    // Neither moves it in the list or makes a version: it is the same Artifact, kept elsewhere.
    expect((await send('PATCH', at, { pinned: true, title: 'Minutes' })).json()).toMatchObject({
      id: memo.id,
      title: 'Minutes',
      version: 1,
      updatedAt: memo.updatedAt,
    });
    expect((await page()).items).toMatchObject([
      { id: deck.id, pinned: false, folderId: null, projectId: null },
      { id: memo.id, pinned: true, title: 'Minutes' },
    ]);
    expect((await page('?pinned=true')).items.map(({ id }) => id)).toEqual([memo.id]);
    expect((await page('?pinned=false')).items.map(({ id }) => id)).toEqual([deck.id]);

    // The copy is another Artifact of the same conversation, private and unpinned, at version 1.
    await services.artifacts.update(owner.id, plans.id, memo.id, { visibility: 'public' });
    await services.artifacts.revise(owner.id, plans.id, { artifactId: memo.id, content: '# Two' });
    const copied = await send('POST', `${at}/duplicate`);
    expect(copied.statusCode).toBe(201);
    const copy = copied.json();
    expect(copy).toMatchObject({
      sessionId: plans.id,
      title: 'Minutes (copy)',
      type: 'markdown',
      version: 1,
      visibility: 'private',
      publicPath: null,
    });
    expect(copy.id).not.toBe(memo.id);
    expect(
      await services.artifacts.read(owner.id, plans.id, { artifactId: copy.id }),
    ).toMatchObject({ content: '# Two', writtenBy: 'agent' });
    expect((await page('?pinned=true')).items.map(({ id }) => id)).toEqual([memo.id]);
    expect((await page('', other.id)).items).toEqual([]);
  });

  it('starts each one under its conversation’s project, and moves it between folders', async () => {
    const { services, owner, other, memo, send, page, folder, kept, folders, at } =
      await organising();
    const project = await projectRow(services.store, owner.id, 'git@github.com:example/site.git');
    const work = await services.sessions.createGatewaySession(owner.id, { projectId: project.id });
    const site = await services.artifacts.create(owner.id, work.id, {
      title: 'Site',
      type: 'html',
      content: '<!doctype html><html><body>Site</body></html>',
    });

    expect(await kept()).toEqual({
      folders: [],
      projects: [
        { projectId: project.id, name: 'example/site', artifacts: 1 },
        { projectId: null, name: null, artifacts: 1 },
      ],
    });
    expect((await page(`?project=${project.id}`)).items).toMatchObject([
      { id: site.id, projectId: project.id, folderId: null },
    ]);
    expect((await page('?project=none')).items.map(({ id }) => id)).toEqual([memo.id]);

    const keep = await folder('Keep');
    const foreign = await folder('Theirs', other.id);
    // Only into a folder of the same agent: another's is not found, and nothing moves.
    expect((await send('PATCH', at, { folderId: foreign.id })).statusCode).toBe(404);
    expect((await send('PATCH', at, { folderId: randomUUID() })).statusCode).toBe(404);
    expect((await send('PATCH', at, { folderId: keep.id })).statusCode).toBe(200);
    expect((await page(`?folder=${keep.id}`)).items).toMatchObject([
      { id: memo.id, folderId: keep.id },
    ]);
    expect((await page('?project=none')).items).toEqual([]);
    expect((await page(`?folder=${foreign.id}`)).items).toEqual([]);
    expect(await kept()).toMatchObject({
      folders: [{ id: keep.id, name: 'Keep', artifacts: 1 }],
      projects: [{ projectId: project.id, artifacts: 1 }],
    });
    expect(await kept(other.id)).toMatchObject({ folders: [{ id: foreign.id, artifacts: 0 }] });

    // A folder is renamed and deleted by its own agent alone.
    const theirs = `${folders(other.id)}/${keep.id}`;
    expect((await send('PATCH', theirs, { name: 'Taken' })).statusCode).toBe(404);
    expect((await send('DELETE', theirs)).statusCode).toBe(404);
    expect((await send('POST', folders(), { name: ' ' })).statusCode).toBe(400);
    expect((await send('POST', folders(), { name: 'Keep' }, {})).statusCode).toBe(401);
    const own = `${folders()}/${keep.id}`;
    expect((await send('PATCH', own, { name: 'Kept' })).json()).toMatchObject({
      id: keep.id,
      name: 'Kept',
      artifacts: 1,
    });

    // Deleting it deletes no Artifact: what it held is back where it started.
    expect((await send('DELETE', own)).statusCode).toBe(204);
    expect((await send('DELETE', own)).statusCode).toBe(404);
    expect((await page('?project=none')).items).toMatchObject([{ id: memo.id, folderId: null }]);
    expect((await kept()).folders).toEqual([]);
    // And back by hand, with no folder at all.
    const again = await folder('Again');
    await send('PATCH', at, { folderId: again.id });
    expect((await send('PATCH', at, { folderId: null })).statusCode).toBe(200);
    expect((await page(`?folder=${again.id}`)).items).toEqual([]);
  });

  it('is refused to a paired phone, which only reads', async () => {
    const { app, phone, send, folder, kept, folders, page, at } = await organising();
    const keep = await folder('Keep');
    const device = await phone();

    expect((await app.inject({ url: folders(), headers: device })).statusCode).toBe(200);
    for (const [method, url, payload] of [
      ['PATCH', at, { pinned: true }],
      ['PATCH', at, { title: 'Taken' }],
      ['PATCH', at, { folderId: keep.id }],
      // Not smuggled in beside a change it may make.
      ['PATCH', at, { visibility: 'private', pinned: true }],
      ['POST', `${at}/duplicate`, undefined],
      ['POST', folders(), { name: 'Phone' }],
      ['PATCH', `${folders()}/${keep.id}`, { name: 'Phone' }],
      ['DELETE', `${folders()}/${keep.id}`, undefined],
    ] as const) {
      expect((await send(method, url, payload, device)).statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await page()).items).toMatchObject([{ title: 'Memo', pinned: false, folderId: null }]);
    expect(await kept()).toMatchObject({ folders: [{ id: keep.id, name: 'Keep', artifacts: 0 }] });
  });
});
