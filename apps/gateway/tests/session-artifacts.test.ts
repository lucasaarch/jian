import { randomUUID } from 'node:crypto';
import {
  DECK_SLIDES_MAX,
  SESSION_ARTIFACT_MAX,
  sessionArtifactSchema,
  sessionArtifactVersionSchema,
} from '@jian/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { profileTools, TOOL_GROUPS } from '../src/agent/tools.js';
import { createApp } from '../src/app.js';
import { sessionArtifacts, sessionArtifactVersions } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-admin-token-with-32-characters';
const headers = { authorization: `Bearer ${token}` };

/** Calls a tool as the model would, with whatever input it sent. */
const use = (tool: unknown, input: object) =>
  (
    tool as { execute: (input: object, context: object) => Promise<Record<string, unknown>> }
  ).execute(input, { toolCallId: 'call-1', messages: [] });

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(mode: 'server' | 'local' = 'server') {
  const services = await testServices(undefined, undefined, undefined, mode);
  const app = createApp({ ...services, token, logger: false, mode });
  apps.push(app);
  const owner = await services.profiles.createProfile({
    name: 'Owner',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(owner.id, { channel: 'api' });
  const at = (rest = '', sessionId = session.id, profileId = owner.id) =>
    `/v1/profiles/${profileId}/sessions/${sessionId}/artifacts${rest}`;
  const make = (input: object = { title: 'Notes', type: 'markdown', content: '# First' }) =>
    services.artifacts.create(owner.id, session.id, input);
  const setVisibility = (artifactId: string, visibility: 'private' | 'public') =>
    app.inject({ method: 'PATCH', url: at(`/${artifactId}`), headers, payload: { visibility } });

  return { services, app, owner, session, at, make, setVisibility };
}

describe('what the agent makes', () => {
  it('keeps every version an update adds, and shows the latest', async () => {
    const { services, app, owner, session, at } = await setup();
    const run = await services.runs.submit(owner.id, session.id, {
      text: 'Draw it.',
      requestKey: 'draw',
    });
    const tools = profileTools(services, run);

    const made = await use(tools.create_artifact, {
      title: 'Notes',
      type: 'markdown',
      content: '# First',
    });
    expect(made).toMatchObject({ title: 'Notes', type: 'markdown', version: 1 });
    // Whether anyone else reads it is the owner's choice, so the agent is handed no link.
    expect(JSON.stringify(made)).not.toContain('public');

    const revised = await use(tools.update_artifact, {
      artifactId: made.artifactId,
      content: '# Second',
      title: 'Renamed',
    });
    expect(revised).toMatchObject({ artifactId: made.artifactId, title: 'Renamed', version: 2 });

    const listed = (await app.inject({ url: at(), headers })).json();
    expect(sessionArtifactSchema.array().parse(listed)).toMatchObject([
      {
        id: made.artifactId,
        title: 'Renamed',
        version: 2,
        visibility: 'private',
        publicPath: null,
      },
    ]);
    const version = async (number: number) =>
      sessionArtifactVersionSchema.parse(
        (await app.inject({ url: at(`/${made.artifactId}/versions/${number}`), headers })).json(),
      );
    expect((await version(1)).content).toBe('# First');
    expect((await version(2)).content).toBe('# Second');
    expect(
      (await app.inject({ url: at(`/${made.artifactId}/versions/3`), headers })).statusCode,
    ).toBe(404);
  });

  it('is not offered to a subagent, whose conversation is not on screen', async () => {
    const { services, owner, session } = await setup();
    const run = await services.runs.submit(owner.id, session.id, {
      text: 'Draw it.',
      requestKey: 'draw',
    });
    const tools = profileTools(services, { ...run, subagent: {} as never });

    for (const name of TOOL_GROUPS.artifacts.tools) expect(tools[name]).toBeUndefined();
    // The reader of stored tool results is another tool, which a subagent keeps.
    expect(tools.read_artifact).toBeDefined();
  });

  it('refuses a component its frame could not run, in words the agent can act on', async () => {
    const { app, at, make } = await setup();

    await expect(
      make({ title: 'Broken', type: 'react', content: 'export default () => <div>' }),
    ).rejects.toMatchObject({ statusCode: 400, message: /does not compile/ });
    await expect(
      make({
        title: 'Chart',
        type: 'react',
        content: "import { LineChart } from 'recharts';\nexport default () => <LineChart />;",
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: /not "recharts"/ });
    await expect(
      make({ title: 'Unnamed', type: 'react', content: 'export const App = () => <p>Hi</p>;' }),
    ).rejects.toMatchObject({ statusCode: 400, message: /default export/ });

    const counter = await make({
      title: 'Counter',
      type: 'react',
      content:
        "import { useState } from 'react';\nexport default function Counter() {\n  const [count, setCount] = useState<number>(0);\n  return <button onClick={() => setCount(count + 1)}>{count}</button>;\n}",
    });
    const version = (await app.inject({ url: at(`/${counter.id}/versions/1`), headers })).json();
    expect(version.content).toContain('<button');
    // What the frame runs has no JSX and no types left in it.
    expect(version.compiled).toContain("createElement('button'");
    expect(version.compiled).not.toContain('<number>');
  });
});

describe('who reads an Artifact', () => {
  it('answers no one without the owner’s credential while it is private', async () => {
    const { app, at, make } = await setup();
    const artifact = await make();

    expect((await app.inject({ url: at() })).statusCode).toBe(401);
    expect((await app.inject({ url: at(`/${artifact.id}/versions/1`) })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: at(`/${artifact.id}`),
          payload: { visibility: 'public' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('is reached only through the conversation it was made in', async () => {
    const { services, app, owner, at, make, setVisibility } = await setup();
    const artifact = await make();
    const elsewhere = await services.sessions.createSession(owner.id, { channel: 'api' });
    const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
    const theirs = await services.sessions.createSession(other.id, { channel: 'api' });

    for (const [sessionId, profileId] of [
      [elsewhere.id, owner.id],
      [theirs.id, other.id],
      // Another profile naming this conversation finds no such conversation.
      [artifact.sessionId, other.id],
    ] as const) {
      const url = at(`/${artifact.id}/versions/1`, sessionId, profileId);
      expect((await app.inject({ url, headers })).statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: at(`/${artifact.id}`, sessionId, profileId),
            headers,
            payload: { visibility: 'public' },
          })
        ).statusCode,
      ).toBe(404);
    }
    expect((await app.inject({ url: at('', elsewhere.id), headers })).json()).toEqual([]);
    // An agent in another conversation cannot give it a version either.
    await expect(
      services.artifacts.revise(owner.id, elsewhere.id, { artifactId: artifact.id, content: 'x' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await setVisibility(artifact.id, 'private')).json()).toMatchObject({ version: 1 });
  });

  it('gives a public one a link that answers only it, sealed, until it is private again', async () => {
    const { services, app, owner, session, make, setVisibility } = await setup();
    const artifact = await make({
      title: 'A <b>title</b>',
      type: 'markdown',
      content: 'Hello </script><script>alert(1)</script>',
    });

    const published = (await setVisibility(artifact.id, 'public')).json();
    expect(published.visibility).toBe('public');
    expect(published.publicPath).toMatch(/^\/v1\/public-artifacts\/[A-Za-z0-9_-]{43}$/);

    // No credential at all: the link is the proof.
    const page = await app.inject({ url: published.publicPath });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['cache-control']).toBe('no-store');
    const policy = String(page.headers['content-security-policy']);
    expect(policy.split('; ')).toEqual(
      expect.arrayContaining([
        "default-src 'none'",
        "connect-src 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        'sandbox allow-scripts',
      ]),
    );
    expect(policy).not.toMatch(/allow-same-origin|unsafe-eval|https?:|\*/);
    // The source arrives as data, and what it holds never reads as the page's own markup.
    expect(page.body).toContain('Hello \\u003c/script>\\u003cscript>alert(1)');
    expect(page.body).not.toContain('<script>alert(1)');
    expect(page.body).not.toContain('<b>title</b>');
    // Nothing of where it came from.
    expect(page.body).not.toContain(owner.id);
    expect(page.body).not.toContain(session.id);
    expect(page.body).not.toContain(artifact.id);

    // The link follows the Artifact to its latest version.
    await services.artifacts.revise(owner.id, session.id, {
      artifactId: artifact.id,
      content: 'Second thoughts',
    });
    expect((await app.inject({ url: published.publicPath })).body).toContain('Second thoughts');

    expect((await setVisibility(artifact.id, 'private')).json()).toMatchObject({
      visibility: 'private',
      publicPath: null,
    });
    expect((await app.inject({ url: published.publicPath })).statusCode).toBe(404);

    // Public again is a new link: the one that was shared stays dead.
    const again = (await setVisibility(artifact.id, 'public')).json();
    expect(again.publicPath).not.toBe(published.publicPath);
    expect((await app.inject({ url: published.publicPath })).statusCode).toBe(404);
    expect((await app.inject({ url: again.publicPath })).statusCode).toBe(200);
    expect((await app.inject({ url: `/v1/public-artifacts/${'A'.repeat(43)}` })).statusCode).toBe(
      404,
    );
  });

  it('never makes one public on the gateway a desktop app runs', async () => {
    const { services, app, at, make, setVisibility } = await setup('local');
    const artifact = await make();

    const refused = await setVisibility(artifact.id, 'public');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/only on a server gateway/);
    expect((await app.inject({ url: at(), headers })).json()).toMatchObject([
      { visibility: 'private', publicPath: null },
    ]);
    // Private is still its to set, and to stay.
    expect((await setVisibility(artifact.id, 'private')).statusCode).toBe(200);

    // Data that arrived from a server with one already public: its link answers nothing here.
    const secret = 'B'.repeat(43);
    await services.store.db
      .update(sessionArtifacts)
      .set({ visibility: 'public', publicToken: secret })
      .where(eq(sessionArtifacts.id, artifact.id));
    expect((await app.inject({ url: `/v1/public-artifacts/${secret}` })).statusCode).toBe(404);
  });
});

describe('the frame the panel draws one in', () => {
  it('holds no Artifact, is kept only by the panel, and reaches nothing', async () => {
    const { app, make } = await setup();
    await make({ title: 'Secret plan', type: 'markdown', content: 'Only for the owner' });

    for (const type of ['html', 'react', 'markdown', 'svg', 'mermaid', 'deck']) {
      const frame = await app.inject({ url: `/v1/artifact-frames/${type}` });
      expect(frame.statusCode).toBe(200);
      expect(frame.headers['content-type']).toBe('text/html; charset=utf-8');
      const policy = String(frame.headers['content-security-policy']).split('; ');
      expect(policy).toEqual(
        expect.arrayContaining([
          "default-src 'none'",
          "connect-src 'none'",
          "frame-ancestors 'self'",
          'sandbox allow-scripts',
        ]),
      );
      expect(frame.body).not.toContain('Only for the owner');
      expect(frame.body).not.toContain('Secret plan');
      // It draws only what its parent hands it.
      expect(frame.body).toContain('event.source === parent');
    }

    // With no library in it, the frame's own script is all there is: it says nothing back.
    for (const type of ['html', 'deck']) {
      const own = (await app.inject({ url: `/v1/artifact-frames/${type}` })).body;
      expect(own).not.toMatch(/postMessage|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
      expect(own).not.toContain('contenteditable');
    }

    expect((await app.inject({ url: '/v1/artifact-frames/python' })).statusCode).toBe(400);
  });

  it('edits in a frame of its own, as sealed, that only answers its parent', async () => {
    const { app } = await setup();

    for (const type of ['html', 'deck']) {
      const frame = await app.inject({ url: `/v1/artifact-frames/${type}?edit=1` });
      expect(frame.statusCode).toBe(200);
      const policy = String(frame.headers['content-security-policy']);
      expect(policy.split('; ')).toEqual(
        expect.arrayContaining([
          "default-src 'none'",
          "connect-src 'none'",
          "form-action 'none'",
          "frame-ancestors 'self'",
          'sandbox allow-scripts',
        ]),
      );
      expect(policy).not.toMatch(/allow-same-origin|unsafe-eval|https?:|\*/);
      // It hands the edit to the panel that holds it and to no one else, and reaches nothing.
      expect(frame.body.match(/postMessage/g)).toHaveLength(1);
      expect(frame.body).toContain('parent.postMessage(');
      expect(frame.body).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|\.submit\(/);
      // What it is handed is read as a document, never written into the page to run.
      expect(frame.body).toContain('new DOMParser()');
    }

    // The types the owner does not edit by hand have no such frame.
    for (const type of ['react', 'markdown', 'svg', 'mermaid']) {
      expect((await app.inject({ url: `/v1/artifact-frames/${type}?edit=1` })).statusCode).toBe(
        400,
      );
    }
    expect((await app.inject({ url: '/v1/artifact-frames/html?edit=yes' })).statusCode).toBe(400);
  });
});

const slide = (text: string) => `<!doctype html><html><body><h1>${text}</h1></body></html>`;

describe('a deck of slides', () => {
  it('keeps a whole version for every change to one slide', async () => {
    const { services, app, owner, session, at } = await setup();
    const run = await services.runs.submit(owner.id, session.id, {
      text: 'Present it.',
      requestKey: 'present',
    });
    const tools = profileTools(services, run);
    const slides = async (artifactId: unknown, number: number) =>
      sessionArtifactVersionSchema.parse(
        (await app.inject({ url: at(`/${artifactId}/versions/${number}`), headers })).json(),
      ).slides;

    const made = await use(tools.create_artifact, {
      title: 'Plan',
      type: 'deck',
      slides: [slide('A'), slide('B')],
    });
    expect(made).toMatchObject({ type: 'deck', version: 1 });
    const id = made.artifactId;

    expect(await use(tools.add_slide, { artifactId: id, html: slide('C') })).toMatchObject({
      version: 2,
      slides: 3,
    });
    expect(
      await use(tools.add_slide, { artifactId: id, html: slide('Start'), position: 1 }),
    ).toMatchObject({ version: 3, slides: 4 });
    expect(
      await use(tools.update_slide, { artifactId: id, slide: 2, html: slide('A2') }),
    ).toMatchObject({ version: 4, slides: 4 });
    expect(await use(tools.move_slide, { artifactId: id, slide: 4, to: 1 })).toMatchObject({
      version: 5,
      slides: 4,
    });
    expect(await use(tools.delete_slide, { artifactId: id, slide: 2 })).toMatchObject({
      version: 6,
      slides: 3,
    });

    // Each version still holds the deck as it then was, in order.
    expect(await slides(id, 1)).toEqual([slide('A'), slide('B')]);
    expect(await slides(id, 2)).toEqual([slide('A'), slide('B'), slide('C')]);
    expect(await slides(id, 3)).toEqual([slide('Start'), slide('A'), slide('B'), slide('C')]);
    expect(await slides(id, 4)).toEqual([slide('Start'), slide('A2'), slide('B'), slide('C')]);
    expect(await slides(id, 5)).toEqual([slide('C'), slide('Start'), slide('A2'), slide('B')]);
    expect(await slides(id, 6)).toEqual([slide('C'), slide('A2'), slide('B')]);

    // The whole deck again is a version too.
    expect(
      await use(tools.update_artifact, { artifactId: id, slides: [slide('Only')] }),
    ).toMatchObject({ version: 7 });
    expect(await slides(id, 7)).toEqual([slide('Only')]);

    const read = await use(tools.read_artifact_source, { artifactId: id, version: 6, slide: 2 });
    expect(read).toMatchObject({
      version: 6,
      latestVersion: 7,
      writtenBy: 'agent',
      slideCount: 3,
      slide: 2,
      html: slide('A2'),
    });
    expect(await use(tools.read_artifact_source, { artifactId: id })).toMatchObject({
      version: 7,
      slides: [{ slide: 1, html: slide('Only') }],
    });
  });

  it('refuses a change its slides cannot take, and keeps no version of it', async () => {
    const { services, owner, session, make } = await setup();
    const deck = await make({ title: 'Plan', type: 'deck', slides: [slide('A')] });
    const notes = await make();
    const change = (op: 'add' | 'update' | 'delete' | 'move', input: object) =>
      services.artifacts.changeSlide(owner.id, session.id, op, { artifactId: deck.id, ...input });

    await expect(change('update', { slide: 2, html: slide('X') })).rejects.toMatchObject({
      statusCode: 400,
      message: /has 1 slide, so there is no slide 2/,
    });
    await expect(change('add', { html: slide('X'), position: 3 })).rejects.toMatchObject({
      statusCode: 400,
      message: /at 1 to 2, not at 3/,
    });
    await expect(change('move', { slide: 1, to: 2 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(change('delete', { slide: 1 })).rejects.toMatchObject({
      statusCode: 400,
      message: /at least one slide/,
    });
    // What the tool's own schema refuses, before the deck is read.
    await expect(change('update', { slide: 0, html: slide('X') })).rejects.toThrow(ZodError);
    await expect(change('update', { slide: 1, html: '' })).rejects.toThrow(ZodError);
    await expect(
      services.artifacts.changeSlide(owner.id, session.id, 'add', {
        artifactId: notes.id,
        html: slide('X'),
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: /Only a deck has slides/ });

    // A deck is its slides and any other type its content, never the other way round.
    await expect(make({ title: 'Plan', type: 'deck', content: slide('A') })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(make({ title: 'Plan', type: 'deck', slides: [] })).rejects.toThrow(ZodError);
    await expect(
      make({
        title: 'Plan',
        type: 'deck',
        slides: Array.from({ length: DECK_SLIDES_MAX + 1 }, () => slide('A')),
      }),
    ).rejects.toThrow(ZodError);
    await expect(make({ title: 'Page', type: 'html', slides: [slide('A')] })).rejects.toMatchObject(
      { statusCode: 400 },
    );
    await expect(
      services.artifacts.revise(owner.id, session.id, { artifactId: deck.id, content: 'x' }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const versions = await services.store.db
      .select()
      .from(sessionArtifactVersions)
      .where(eq(sessionArtifactVersions.artifactId, deck.id));
    expect(versions).toHaveLength(1);
  });

  it('is public as a page that holds every slide and nothing to edit them with', async () => {
    const { app, make, setVisibility } = await setup();
    const deck = await make({
      title: 'Plan',
      type: 'deck',
      slides: [slide('First </script><script>alert(1)</script>'), slide('Second')],
    });
    const { publicPath } = (await setVisibility(deck.id, 'public')).json();

    const page = await app.inject({ url: publicPath });
    expect(page.statusCode).toBe(200);
    expect(String(page.headers['content-security-policy'])).toContain('sandbox allow-scripts');
    expect(page.body).toContain('Second');
    expect(page.body).not.toContain('<script>alert(1)');
    // Each slide is a frame written into the page, as sealed as the page.
    expect(page.body).toContain("setAttribute('sandbox', 'allow-scripts')");
    expect(page.body).not.toMatch(/postMessage|contenteditable|jian-edit|fetch\(/i);
    // A link reads, with or without asking for the editing frame.
    expect((await app.inject({ url: `${publicPath}?edit=1` })).body).not.toMatch(
      /postMessage|contenteditable|jian-edit/i,
    );
  });
});

describe('what the owner edits by hand', () => {
  const page = (text: string) => `<!doctype html><html><body><p>${text}</p></body></html>`;

  it('saves a new version of theirs, from the version they were editing', async () => {
    const { services, app, owner, session, at, make } = await setup();
    const html = await make({ title: 'Page', type: 'html', content: page('Agent') });
    const save = (artifactId: string, payload: object) =>
      app.inject({ method: 'POST', url: at(`/${artifactId}/versions`), headers, payload });
    const version = async (artifactId: string, number: number) =>
      sessionArtifactVersionSchema.parse(
        (await app.inject({ url: at(`/${artifactId}/versions/${number}`), headers })).json(),
      );

    const saved = await save(html.id, { version: 1, content: page('Owner') });
    expect(saved.statusCode).toBe(201);
    expect(sessionArtifactSchema.parse(saved.json())).toMatchObject({ id: html.id, version: 2 });
    expect(await version(html.id, 1)).toMatchObject({ author: 'agent', content: page('Agent') });
    expect(await version(html.id, 2)).toMatchObject({ author: 'owner', content: page('Owner') });
    // The agent is told whose the latest is before it writes over it.
    expect(
      await services.artifacts.read(owner.id, session.id, { artifactId: html.id }),
    ).toMatchObject({ version: 2, writtenBy: 'owner', content: page('Owner') });
    await services.artifacts.revise(owner.id, session.id, {
      artifactId: html.id,
      content: page('Agent again'),
    });
    expect(await version(html.id, 3)).toMatchObject({ author: 'agent' });

    // A deck gets the one slide, in the deck as it was in the version that was edited.
    const deck = await make({ title: 'Plan', type: 'deck', slides: [slide('A'), slide('B')] });
    await services.artifacts.changeSlide(owner.id, session.id, 'add', {
      artifactId: deck.id,
      html: slide('C'),
    });
    const edited = await save(deck.id, { version: 1, slide: 2, content: slide('B, edited') });
    expect(edited.statusCode).toBe(201);
    expect(edited.json()).toMatchObject({ version: 3 });
    expect(await version(deck.id, 3)).toMatchObject({
      author: 'owner',
      slides: [slide('A'), slide('B, edited')],
    });
    expect((await version(deck.id, 2)).slides).toEqual([slide('A'), slide('B'), slide('C')]);
  });

  it('takes an edit only with the owner’s credential, never through a public link', async () => {
    const { services, app, owner, at, make, setVisibility } = await setup();
    const html = await make({ title: 'Page', type: 'html', content: page('Agent') });
    const { publicPath } = (await setVisibility(html.id, 'public')).json();
    const secret = publicPath.split('/').at(-1);
    const payload = { version: 1, content: page('Stranger') };
    const url = at(`/${html.id}/versions`);

    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    // The link's secret is proof of a reader and of nothing else.
    for (const authorization of [`Bearer ${secret}`, 'Bearer wrong-token-with-32-characters!!']) {
      expect(
        (await app.inject({ method: 'POST', url, headers: { authorization }, payload })).statusCode,
      ).toBe(401);
    }
    expect(
      (await app.inject({ method: 'POST', url: `${url}?token=${secret}`, payload })).statusCode,
    ).toBe(401);
    // And the link itself takes nothing: only reading it is open, and even the owner finds no
    // route there to write to.
    for (const method of ['POST', 'PUT', 'PATCH'] as const) {
      for (const url of [publicPath, `${publicPath}/versions`]) {
        expect((await app.inject({ method, url, payload })).statusCode).toBe(401);
        expect((await app.inject({ method, url, headers, payload })).statusCode).toBe(404);
      }
    }

    // Nor through another conversation or another profile, with the credential.
    const elsewhere = await services.sessions.createSession(owner.id, { channel: 'api' });
    const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
    const theirs = await services.sessions.createSession(other.id, { channel: 'api' });
    for (const [sessionId, profileId] of [
      [elsewhere.id, owner.id],
      [theirs.id, other.id],
      [html.sessionId, other.id],
    ] as const) {
      const refused = await app.inject({
        method: 'POST',
        url: at(`/${html.id}/versions`, sessionId, profileId),
        headers,
        payload,
      });
      expect(refused.statusCode).toBe(404);
    }

    expect((await app.inject({ url: at(), headers })).json()).toMatchObject([{ version: 1 }]);
    expect((await app.inject({ url: publicPath })).body).not.toContain('Stranger');
  });

  it('refuses what is not an edit of that Artifact, and keeps no version of it', async () => {
    const { services, app, at, make } = await setup();
    const html = await make({ title: 'Page', type: 'html', content: page('Agent') });
    const deck = await make({ title: 'Plan', type: 'deck', slides: [slide('A')] });
    const notes = await make();
    const save = async (artifactId: string, payload: Record<string, unknown>) =>
      (await app.inject({ method: 'POST', url: at(`/${artifactId}/versions`), headers, payload }))
        .statusCode;

    expect(await save(html.id, { version: 1 })).toBe(400);
    expect(await save(html.id, { version: 1, content: '' })).toBe(400);
    expect(await save(html.id, { version: 1, content: { html: page('x') } })).toBe(400);
    expect(await save(html.id, { version: 1, content: [page('x')] })).toBe(400);
    expect(await save(html.id, { version: 1, content: page('x'), author: 'agent' })).toBe(400);
    expect(await save(html.id, { version: 0, content: page('x') })).toBe(400);
    expect(await save(html.id, { content: page('x') })).toBe(400);
    expect(await save(html.id, { version: 1, content: 'x'.repeat(SESSION_ARTIFACT_MAX + 1) })).toBe(
      400,
    );
    // A version it never had, a slide of a page, a deck with no slide named, a slide it lacks.
    expect(await save(html.id, { version: 2, content: page('x') })).toBe(404);
    expect(await save(html.id, { version: 1, content: page('x'), slide: 1 })).toBe(400);
    expect(await save(deck.id, { version: 1, content: slide('x') })).toBe(400);
    expect(await save(deck.id, { version: 1, content: slide('x'), slide: 2 })).toBe(400);
    // The types that are not edited by hand.
    expect(await save(notes.id, { version: 1, content: '# Mine' })).toBe(409);
    expect(await save('not-an-id', { version: 1, content: page('x') })).toBe(400);
    expect(await save(randomUUID(), { version: 1, content: page('x') })).toBe(404);

    // The most a page holds is taken, though it is more than a request usually carries.
    expect(await save(html.id, { version: 1, content: 'é'.repeat(SESSION_ARTIFACT_MAX) })).toBe(
      201,
    );

    const versions = await services.store.db.select().from(sessionArtifactVersions);
    expect(versions.map(({ author }) => author).sort()).toEqual([
      'agent',
      'agent',
      'agent',
      'owner',
    ]);
  });
});
