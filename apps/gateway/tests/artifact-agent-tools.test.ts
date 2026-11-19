import type { Run } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { actionKind } from '../src/agent/guard.js';
import { profileTools } from '../src/agent/tools.js';
import { createApp } from '../src/app.js';
import { SessionArtifacts } from '../src/artifacts/service.js';
import { events, mediaAssets, sessionArtifactVersions } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-admin-token-with-32-characters';
const page = (text: string) => `<!doctype html><html><body><p>${text}</p></body></html>`;
const slide = (text: string) => `<!doctype html><html><body><h1>${text}</h1></body></html>`;

/** Calls a tool as the model would, with whatever input it sent. */
const use = (tool: unknown, input: object, toolCallId = 'call-1') =>
  (
    tool as { execute: (input: object, context: object) => Promise<Record<string, unknown>> }
  ).execute(input, { toolCallId, messages: [] });

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
  const run = await services.runs.submit(owner.id, session.id, {
    text: 'Work on it.',
    requestKey: 'work',
  });
  const make = (input: object) => services.artifacts.create(owner.id, session.id, input);
  const versions = async (artifactId: string) =>
    (
      await services.store.db
        .select()
        .from(sessionArtifactVersions)
        .where(eq(sessionArtifactVersions.artifactId, artifactId))
    ).sort((a, b) => a.version - b.version);

  return { services, app, owner, session, run, make, versions };
}

describe('edit_artifact', () => {
  it('replaces only what it names, as a new version on top of the latest', async () => {
    const { services, owner, session, run, make, versions } = await setup();
    const tools = profileTools(services, run);
    const made = await make({
      title: 'Page',
      type: 'html',
      content: page('Hello, <b>world</b>. Goodbye.'),
    });

    expect(
      await use(tools.edit_artifact, {
        artifactId: made.id,
        edits: [
          { find: '<b>world</b>', replace: '<i>there</i>' },
          // Applies to what the edit before it left.
          { find: '<i>there</i>.', replace: '<i>there</i>!' },
          { find: ' Goodbye.', replace: '' },
        ],
      }),
    ).toMatchObject({ artifactId: made.id, version: 2 });
    expect((await versions(made.id)).map(({ author, content }) => [author, content])).toEqual([
      ['agent', page('Hello, <b>world</b>. Goodbye.')],
      ['agent', page('Hello, <i>there</i>!')],
    ]);

    // The panel is told to bring it forward, as for any version the agent makes.
    const focused = (await services.store.db.select().from(events))
      .filter((event) => event.type === 'conversation.inspector.focus')
      .map((event) => event.data);
    expect(focused).toHaveLength(2);
    expect(focused.at(-1)).toEqual({
      sessionId: session.id,
      kind: 'artifact',
      artifactId: made.id,
    });

    // The owner's hand edit is the latest, and the next edit builds on it, not on the agent's.
    await services.artifacts.edit(owner.id, session.id, made.id, {
      version: 2,
      content: page('Hello, <i>there</i>! Signed, the owner.'),
    });
    await use(tools.edit_artifact, {
      artifactId: made.id,
      edits: [{ find: 'Hello', replace: 'Hi' }],
    });
    expect((await versions(made.id)).at(-1)).toMatchObject({
      version: 4,
      author: 'agent',
      content: page('Hi, <i>there</i>! Signed, the owner.'),
    });
  });

  it('refuses the whole call when one edit matches nothing or more than one place', async () => {
    const { services, run, make, versions } = await setup();
    const tools = profileTools(services, run);
    const made = await make({ title: 'Notes', type: 'markdown', content: '# Plan\n\n- a\n- a\n' });
    const edit = (edits: object[]) => use(tools.edit_artifact, { artifactId: made.id, edits });

    await expect(
      edit([
        { find: '# Plan', replace: '# The plan' },
        { find: '- b', replace: '- c' },
      ]),
    ).rejects.toMatchObject({ statusCode: 400, message: /^Edit 2 of 2 matched nothing/ });
    await expect(edit([{ find: '- a', replace: '- b' }])).rejects.toMatchObject({
      statusCode: 400,
      message: /^The edit matched 2 places/,
    });
    // Overlapping places count: "aa" is twice in "aaa".
    const twice = await make({ title: 'Row', type: 'markdown', content: 'aaa' });
    await expect(
      use(tools.edit_artifact, { artifactId: twice.id, edits: [{ find: 'aa', replace: 'b' }] }),
    ).rejects.toMatchObject({ message: /matched 2 places/ });
    await expect(edit([{ find: '# Plan', replace: '# Plan' }])).rejects.toMatchObject({
      message: /as it was/,
    });
    await expect(edit([])).rejects.toBeInstanceOf(ZodError);
    await expect(edit([{ find: '', replace: 'x' }])).rejects.toBeInstanceOf(ZodError);

    // A component still has to compile after the edit.
    const component = await make({
      title: 'Hi',
      type: 'react',
      content: 'export default function Hi() {\n  return <p>Hi</p>;\n}',
    });
    await expect(
      use(tools.edit_artifact, {
        artifactId: component.id,
        edits: [{ find: '</p>', replace: '' }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: /does not compile/ });

    // Nothing of any refused call was kept.
    expect((await versions(made.id)).map(({ version }) => version)).toEqual([1]);
    expect((await versions(component.id)).map(({ version }) => version)).toEqual([1]);
  });

  it('edits one slide of a deck, and only when it is told which', async () => {
    const { services, run, make, versions } = await setup();
    const tools = profileTools(services, run);
    const deck = await make({ title: 'Plan', type: 'deck', slides: [slide('One'), slide('Two')] });

    await expect(
      use(tools.edit_artifact, { artifactId: deck.id, edits: [{ find: 'Two', replace: '2' }] }),
    ).rejects.toMatchObject({ statusCode: 400, message: /say which `slide`.*It has 2/ });
    await expect(
      use(tools.edit_artifact, {
        artifactId: deck.id,
        slide: 3,
        edits: [{ find: 'Two', replace: '2' }],
      }),
    ).rejects.toMatchObject({ message: /no slide 3/ });
    // The text is in the other slide, not this one.
    await expect(
      use(tools.edit_artifact, {
        artifactId: deck.id,
        slide: 1,
        edits: [{ find: 'Two', replace: '2' }],
      }),
    ).rejects.toMatchObject({ message: /matched nothing in slide 1/ });

    expect(
      await use(tools.edit_artifact, {
        artifactId: deck.id,
        slide: 2,
        edits: [{ find: '<h1>Two</h1>', replace: '<h1>Second</h1>' }],
      }),
    ).toMatchObject({ version: 2, slides: 2 });
    expect(JSON.parse((await versions(deck.id)).at(-1)?.content ?? '')).toEqual({
      slides: [slide('One'), slide('Second')],
    });

    const notes = await make({ title: 'Notes', type: 'markdown', content: '# One' });
    await expect(
      use(tools.edit_artifact, {
        artifactId: notes.id,
        slide: 1,
        edits: [{ find: 'One', replace: 'Two' }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: /Only a deck has slides/ });
  });

  it('reaches no Artifact of another conversation or another agent', async () => {
    const { services, owner, run, make, versions } = await setup();
    const made = await make({ title: 'Page', type: 'html', content: page('Mine') });
    const elsewhere = await services.sessions.createSession(owner.id, { channel: 'api' });
    const other = await services.profiles.createProfile({
      name: 'Other',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const otherSession = await services.sessions.createSession(other.id, { channel: 'api' });
    const edit = { artifactId: made.id, edits: [{ find: 'Mine', replace: 'Taken' }] };

    for (const [profileId, sessionId] of [
      [owner.id, elsewhere.id],
      [other.id, otherSession.id],
      [other.id, run.sessionId],
    ] as const) {
      await expect(services.artifacts.editSource(profileId, sessionId, edit)).rejects.toMatchObject(
        { statusCode: 404 },
      );
    }
    expect(await versions(made.id)).toHaveLength(1);
  });
});

describe('share_artifact', () => {
  it('answers a new link each time it is made public, and none once private', async () => {
    const { services, app, run, make } = await setup();
    const artifacts = new SessionArtifacts(
      services.store,
      services.sessions,
      undefined,
      false,
      'https://jian.example.test',
    );
    const tools = profileTools({ ...services, artifacts }, run);
    const made = await make({ title: 'Page', type: 'html', content: page('Shared') });
    const share = (visibility: string) =>
      use(tools.share_artifact, { artifactId: made.id, visibility });

    const first = await share('public');
    expect(first).toMatchObject({ artifactId: made.id, visibility: 'public' });
    const link = String(first.link);
    expect(link).toMatch(/^https:\/\/jian\.example\.test\/v1\/public-artifacts\/[\w-]{43}$/);
    const path = new URL(link).pathname;
    expect((await app.inject({ url: path })).statusCode).toBe(200);

    expect(await share('private')).toMatchObject({ visibility: 'private' });
    expect(await share('private')).not.toHaveProperty('link');
    expect((await app.inject({ url: path })).statusCode).toBe(404);

    const second = await share('public');
    expect(second.link).not.toBe(link);
    expect((await app.inject({ url: path })).statusCode).toBe(404);
    expect((await app.inject({ url: new URL(String(second.link)).pathname })).statusCode).toBe(200);

    // Making one public hands it to anyone with the link, so it is an action that may ask first;
    // taking it back is not.
    expect(actionKind('share_artifact', { artifactId: made.id, visibility: 'public' })).toBe(
      'message',
    );
    expect(
      actionKind('share_artifact', { artifactId: made.id, visibility: 'private' }),
    ).toBeUndefined();
  });

  it('says it has only the path when the gateway does not know its own address', async () => {
    const { services, run, make } = await setup();
    const made = await make({ title: 'Page', type: 'html', content: page('Shared') });

    const shared = await use(profileTools(services, run).share_artifact, {
      artifactId: made.id,
      visibility: 'public',
    });
    expect(shared).not.toHaveProperty('link');
    expect(shared.path).toMatch(/^\/v1\/public-artifacts\/[\w-]{43}$/);
    expect(shared.note).toMatch(/JIAN_PUBLIC_URL/);
  });

  it('makes none public on the gateway a desktop app runs', async () => {
    const { services, run, make } = await setup('local');
    const made = await make({ title: 'Page', type: 'html', content: page('Here') });

    await expect(
      use(profileTools(services, run).share_artifact, {
        artifactId: made.id,
        visibility: 'public',
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: /only on a server gateway/ });
  });
});

describe('send_artifact', () => {
  const media = async (services: Awaited<ReturnType<typeof setup>>['services'], id: unknown) =>
    (
      await services.store.db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.id, String(id)))
    )[0];

  it('sends the source, or a file made from it, in this conversation or another', async () => {
    const { services, owner, run, make } = await setup();
    const tools = profileTools(services, run);
    const html = await make({ title: 'Launch: plan / v2', type: 'html', content: page('Plan') });

    const sent = await use(tools.send_artifact, { artifactId: html.id, format: 'html' }, 'send-1');
    expect(sent).toMatchObject({ name: 'Launch- plan - v2.html', version: 1 });
    expect(await media(services, sent.mediaId)).toMatchObject({
      sessionId: run.sessionId,
      mimeType: 'text/html',
      name: 'Launch- plan - v2.html',
      data: Buffer.from(page('Plan')).toString('base64'),
    });
    // A retried call sends nothing twice.
    expect(
      await use(tools.send_artifact, { artifactId: html.id, format: 'html' }, 'send-1'),
    ).toMatchObject({ mediaId: sent.mediaId });

    // A component's source has no type of its own, and is sent as text.
    const component = await make({
      title: 'Hi',
      type: 'react',
      content: 'export default function Hi() {\n  return <p>Hi</p>;\n}',
    });
    const tsx = await use(tools.send_artifact, { artifactId: component.id, format: 'tsx' }, 's2');
    expect(await media(services, tsx.mediaId)).toMatchObject({
      name: 'Hi.tsx',
      mimeType: 'text/plain',
    });

    // A spreadsheet's CSV is its values, as the panel downloads it, in another conversation.
    const elsewhere = await services.sessions.createSession(owner.id, { channel: 'api' });
    const sheet = await make({ title: 'Costs', type: 'sheet', content: 'a,b\n2,=A2*3' });
    const csv = await use(
      tools.send_artifact,
      { artifactId: sheet.id, format: 'csv', sessionId: elsewhere.id, caption: 'The costs' },
      's3',
    );
    expect(csv).toMatchObject({ sessionId: elsewhere.id, name: 'Costs.csv' });
    const file = await media(services, csv.mediaId);
    expect(file).toMatchObject({ sessionId: elsewhere.id, mimeType: 'text/csv' });
    expect(Buffer.from(String(file?.data), 'base64').toString()).toContain('6');
  });

  it('refuses a format its type does not have, saying which it has', async () => {
    const { services, run, make } = await setup();
    const tools = profileTools(services, run);
    const html = await make({ title: 'Page', type: 'html', content: page('Plan') });
    const deck = await make({ title: 'Plan', type: 'deck', slides: [slide('One')] });

    await expect(
      use(tools.send_artifact, { artifactId: html.id, format: 'pdf' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'This html Artifact is sent as html, not pdf.',
    });
    await expect(
      use(tools.send_artifact, { artifactId: deck.id, format: 'md' }),
    ).rejects.toMatchObject({ message: /sent as pdf or pptx or png, not md/ });
    await expect(
      use(tools.send_artifact, { artifactId: html.id, format: 'gif' }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      use(tools.send_artifact, { artifactId: html.id, format: 'html', slide: 1 }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await services.store.db.select().from(mediaAssets)).toEqual([]);
  });

  it('sends nothing of another agent, nor into its conversations', async () => {
    const { services, run, make } = await setup();
    const tools = profileTools(services, run);
    const made = await make({ title: 'Page', type: 'html', content: page('Mine') });
    const other = await services.profiles.createProfile({
      name: 'Other',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const theirs = await services.sessions.createSession(other.id, { channel: 'api' });
    const otherRun: Run = await services.runs.submit(other.id, theirs.id, {
      text: 'Take it.',
      requestKey: 'take',
    });

    await expect(
      use(tools.send_artifact, { artifactId: made.id, format: 'html', sessionId: theirs.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      use(profileTools(services, otherRun).send_artifact, {
        artifactId: made.id,
        format: 'html',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await services.store.db.select().from(mediaAssets)).toEqual([]);
  });

  it('draws no deck on the gateway a desktop app runs, which has no browser to', async () => {
    const { services, run, make } = await setup('local');
    const deck = await make({ title: 'Plan', type: 'deck', slides: [slide('One')] });

    await expect(
      use(profileTools(services, run).send_artifact, { artifactId: deck.id, format: 'pdf' }),
    ).rejects.toMatchObject({ statusCode: 409, message: /only on a server gateway/ });
  });
});
