import { sessionArtifactSchema, sessionArtifactVersionSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { profileTools } from '../src/agent/tools.js';
import { createApp } from '../src/app.js';
import { sessionArtifacts } from '../src/storage/schema.js';
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

    expect(tools.create_artifact).toBeUndefined();
    expect(tools.update_artifact).toBeUndefined();
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

    for (const type of ['html', 'react', 'markdown', 'svg', 'mermaid']) {
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
    const own = (await app.inject({ url: '/v1/artifact-frames/html' })).body;
    expect(own).not.toMatch(/postMessage|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);

    expect((await app.inject({ url: '/v1/artifact-frames/python' })).statusCode).toBe(400);
  });
});
