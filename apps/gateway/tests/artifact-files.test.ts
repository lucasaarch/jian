import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionArtifactSchema, sessionArtifactVersionSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { profileTools } from '../src/agent/tools.js';
import { createApp } from '../src/app.js';
import { mediaAssets, sessionArtifacts } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

/**
 * A file as an Artifact: kept as media of its conversation, read by its owner alone while it is
 * private, and by a link's holder only as a page while it is public.
 */

const token = 'synthetic-admin-token-with-32-characters';
const headers = { authorization: `Bearer ${token}` };
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=';

const apps: FastifyInstance[] = [];
const undo: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const one of undo.splice(0)) await one();
});

async function setup(mode: 'server' | 'local' = 'server') {
  // What the agent's file tools reach, and so the only place a path may name.
  const home = await mkdtemp(join(tmpdir(), 'jian-artifact-files-'));
  const before = process.env.JIAN_WORKSPACES;
  process.env.JIAN_WORKSPACES = home;
  undo.push(async () => {
    if (before === undefined) delete process.env.JIAN_WORKSPACES;
    else process.env.JIAN_WORKSPACES = before;
    await rm(home, { recursive: true, force: true });
  });

  const services = await testServices(undefined, undefined, undefined, mode);
  const app = createApp({
    ...services,
    token,
    logger: false,
    mode,
    publicUrl: 'https://jian.example.test',
  });
  apps.push(app);
  const owner = await services.profiles.createProfile({
    name: 'Owner',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(owner.id, { channel: 'api' });
  const at = (rest = '', sessionId = session.id, profileId = owner.id) =>
    `/v1/profiles/${profileId}/sessions/${sessionId}/artifacts${rest}`;
  const media = (mediaId: string, profileId = owner.id) =>
    `/v1/profiles/${profileId}/media/${mediaId}`;
  const written = async (name: string, content: string | Buffer) => {
    const path = join(home, name);
    await writeFile(path, content);
    return path;
  };
  const make = (input: object) => services.artifacts.create(owner.id, session.id, input);
  const setVisibility = (artifactId: string, visibility: 'private' | 'public') =>
    app.inject({ method: 'PATCH', url: at(`/${artifactId}`), headers, payload: { visibility } });

  return { services, app, owner, session, home, at, media, written, make, setVisibility };
}

describe('a file as an Artifact', () => {
  it('keeps the file as it was given, and another file as another version', async () => {
    const { services, app, owner, session, at, media, written, make } = await setup();
    const bytes = Buffer.from('%PDF-1.4\n\u0000\u00ff synthetic');
    const made = await make({
      title: 'Report',
      type: 'file',
      path: await written('report.pdf', bytes),
    });

    expect(sessionArtifactSchema.parse(made)).toMatchObject({
      type: 'file',
      version: 1,
      file: { name: 'report.pdf', mimeType: 'application/pdf', bytes: bytes.length },
    });
    const first = made.file?.mediaId as string;

    // An attachment of the conversation is named where it already is: no second copy of it.
    const image = await services.media.upload(owner.id, session.id, {
      mimeType: 'image/png',
      data: PNG,
    });
    const count = async () => (await services.store.db.select().from(mediaAssets)).length;
    const held = await count();
    const revised = await services.artifacts.revise(owner.id, session.id, {
      artifactId: made.id,
      mediaId: image.id,
    });
    expect(revised).toMatchObject({
      version: 2,
      file: { mediaId: image.id, mimeType: 'image/png', name: 'file.png' },
    });
    expect(await count()).toBe(held);

    expect((await app.inject({ url: at(), headers })).json()).toMatchObject([
      { id: made.id, type: 'file', version: 2, file: { mediaId: image.id } },
    ]);
    // Each version still answers its own file, and no source: the bytes are read as media.
    const old = (await app.inject({ url: at(`/${made.id}/versions/1`), headers })).json();
    expect(sessionArtifactVersionSchema.parse(old)).toMatchObject({
      content: '',
      file: { mediaId: first, name: 'report.pdf' },
    });
    const read = (await app.inject({ url: media(first), headers })).json();
    expect(Buffer.from(read.data, 'base64').equals(bytes)).toBe(true);

    // The agent reads back what the file is, not what it holds.
    const run = { profileId: owner.id, sessionId: session.id } as Parameters<
      typeof profileTools
    >[1];
    const tool = profileTools(services, run).read_artifact_source as unknown as {
      execute: (input: object, context: object) => Promise<Record<string, unknown>>;
    };
    const back = await tool.execute({ artifactId: made.id }, { toolCallId: 'c', messages: [] });
    expect(back).toMatchObject({ type: 'file', version: 2, file: { mediaId: image.id } });
    expect(back).not.toHaveProperty('content');
  });

  it('refuses what is not a file of this conversation, and keeps no version of it', async () => {
    const { services, app, owner, session, home, at, written, make } = await setup();
    const path = await written('notes.txt', 'Notes');
    const file = await make({ title: 'Notes', type: 'file', path });
    const page = await make({ title: 'Page', type: 'markdown', content: '# Page' });
    const elsewhere = await services.sessions.createSession(owner.id, { channel: 'api' });
    const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
    const theirs = await services.sessions.createSession(other.id, { channel: 'api' });
    const upload = (profileId: string, sessionId: string) =>
      services.media.upload(profileId, sessionId, { mimeType: 'image/png', data: PNG });
    const revise = (input: object) =>
      services.artifacts.revise(owner.id, session.id, { artifactId: file.id, ...input });

    // A file is a file, and nothing else is one.
    await expect(revise({ content: 'Text' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(revise({})).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      revise({ path, mediaId: (await upload(owner.id, session.id)).id }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      services.artifacts.revise(owner.id, session.id, { artifactId: page.id, path }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(make({ title: 'Both', type: 'file', path, content: 'x' })).rejects.toMatchObject({
      statusCode: 400,
    });

    // Media of another conversation, or of another profile, is not this conversation's to show.
    await expect(
      revise({ mediaId: (await upload(owner.id, elsewhere.id)).id }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(revise({ mediaId: (await upload(other.id, theirs.id)).id })).rejects.toMatchObject(
      { statusCode: 404 },
    );

    // A path is held to the line the file tools are: nothing outside what the agent reaches.
    const outside = await mkdtemp(join(tmpdir(), 'jian-outside-'));
    undo.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'secret.txt'), 'Secret');
    await expect(revise({ path: join(outside, 'secret.txt') })).rejects.toThrow(/outside/);
    await expect(revise({ path: 'notes.txt' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(revise({ path: home })).rejects.toThrow();
    await expect(revise({ path: await written('empty.txt', '') })).rejects.toMatchObject({
      statusCode: 400,
    });

    // Nor is a file edited by hand.
    const edit = await app.inject({
      method: 'POST',
      url: at(`/${file.id}/versions`),
      headers,
      payload: { version: 1, content: '<p>Edited</p>' },
    });
    expect(edit.statusCode).toBe(409);

    expect((await app.inject({ url: at(), headers })).json()).toMatchObject([
      { id: page.id, version: 1 },
      { id: file.id, version: 1, file: { name: 'notes.txt' } },
    ]);
    // A version refused left no media behind it either.
    expect(
      await services.store.db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(eq(mediaAssets.sessionId, session.id)),
    ).toHaveLength(2);
  });
});

describe('who reads a file', () => {
  it('answers no one without the owner’s credential while it is private', async () => {
    const { services, app, at, media, written, make } = await setup();
    const file = await make({
      title: 'Plan',
      type: 'file',
      path: await written('plan.txt', 'A private plan'),
    });
    const mediaId = file.file?.mediaId as string;
    const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
    const theirs = await services.sessions.createSession(other.id, { channel: 'api' });

    for (const url of [at(), at(`/${file.id}/versions/1`), media(mediaId)]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers })).statusCode).toBe(200);
    }
    // Another profile finds neither the Artifact nor its bytes, with the credential.
    expect((await app.inject({ url: media(mediaId, other.id), headers })).statusCode).toBe(404);
    expect(
      (await app.inject({ url: at(`/${file.id}/versions/1`, theirs.id, other.id), headers }))
        .statusCode,
    ).toBe(404);
    // And a link nobody was given answers nothing.
    expect((await app.inject({ url: `/v1/public-artifacts/${'A'.repeat(43)}` })).statusCode).toBe(
      404,
    );
  });

  it('gives a public one a link that answers only that file, as a page, until it is private again', async () => {
    const { services, app, owner, session, written, make, setVisibility } = await setup();
    const text = 'Hello </script><script>alert(1)</script>';
    const file = await make({
      title: 'A <b>title</b>',
      type: 'file',
      path: await written('notes <b>.txt', text),
    });
    const beside = await services.media.upload(owner.id, session.id, {
      mimeType: 'image/png',
      data: PNG,
    });

    const published = (await setVisibility(file.id, 'public')).json();
    expect(published).toMatchObject({ visibility: 'public', file: { name: 'notes <b>.txt' } });

    // No credential at all: the link is the proof.
    const page = await app.inject({ url: published.publicPath });
    expect(page.statusCode).toBe(200);
    // A page, never the file's own bytes under a type a browser would run or draw as a document.
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['cache-control']).toBe('no-store');
    const policy = String(page.headers['content-security-policy']);
    expect(policy.split('; ')).toEqual(
      expect.arrayContaining([
        "default-src 'none'",
        "connect-src 'none'",
        "form-action 'none'",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        'sandbox allow-scripts allow-downloads',
      ]),
    );
    expect(policy).not.toMatch(/allow-same-origin|unsafe-eval|https?:|\*/);
    // The file arrives as data, and nothing it holds or is named reads as the page's markup.
    expect(page.body).toContain(Buffer.from(text).toString('base64'));
    expect(page.body).not.toContain('<script>alert(1)');
    expect(page.body).not.toContain('<b>');
    expect(page.body).not.toContain('<iframe');
    // Nothing of where it came from, and no other file of the conversation.
    for (const hidden of [owner.id, session.id, file.id, file.file?.mediaId, beside.id, PNG]) {
      expect(page.body).not.toContain(hidden);
    }

    // The link follows the Artifact to its latest file.
    await services.artifacts.revise(owner.id, session.id, {
      artifactId: file.id,
      mediaId: beside.id,
    });
    const next = (await app.inject({ url: published.publicPath })).body;
    expect(next).toContain(PNG);
    expect(next).not.toContain(Buffer.from(text).toString('base64'));

    expect((await setVisibility(file.id, 'private')).json()).toMatchObject({
      visibility: 'private',
      publicPath: null,
    });
    expect((await app.inject({ url: published.publicPath })).statusCode).toBe(404);
    // Public again is a new link: the one that was shared stays dead.
    const again = (await setVisibility(file.id, 'public')).json();
    expect(again.publicPath).not.toBe(published.publicPath);
    expect((await app.inject({ url: published.publicPath })).statusCode).toBe(404);
    expect((await app.inject({ url: again.publicPath })).statusCode).toBe(200);
  });

  it('draws a public Markdown file in the sealed frame a document has', async () => {
    const { app, written, make, setVisibility } = await setup();
    const file = await make({
      title: 'Guide',
      type: 'file',
      path: await written('guide.md', '# Guide\n\n<img src=x onerror=alert(1)>'),
    });
    const { publicPath } = (await setVisibility(file.id, 'public')).json();

    const page = await app.inject({ url: publicPath });
    expect(page.statusCode).toBe(200);
    // What the file holds becomes markup only one frame in, where it can go nowhere.
    expect(page.body).toMatch(/<iframe id="artifact" sandbox="allow-scripts"[^>]* srcdoc="/);
    expect(page.body.match(/<iframe/g)).toHaveLength(1);
    expect(page.body).not.toContain('<img src=x');
    const policy = String(page.headers['content-security-policy']);
    expect(policy).toContain("frame-src 'none'");
    // That page offers nothing to take away, so it may save nothing.
    expect(policy).not.toContain('allow-downloads');
  });

  it('never makes a file public on the gateway a desktop app runs', async () => {
    const { services, app, written, make, setVisibility } = await setup('local');
    const file = await make({
      title: 'Plan',
      type: 'file',
      path: await written('plan.txt', 'A private plan'),
    });

    const refused = await setVisibility(file.id, 'public');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/only on a server gateway/);

    // Data that arrived from a server with one already public: its link answers nothing here.
    const secret = 'B'.repeat(43);
    await services.store.db
      .update(sessionArtifacts)
      .set({ visibility: 'public', publicToken: secret })
      .where(eq(sessionArtifacts.id, file.id));
    expect((await app.inject({ url: `/v1/public-artifacts/${secret}` })).statusCode).toBe(404);
  });
});
