import { randomUUID } from 'node:crypto';
import {
  ARTIFACT_EDIT_MESSAGE,
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

  it('keeps a diagram as JSON whose every reference holds, its places optional', async () => {
    const { services, app, owner, session, at, make } = await setup();
    const diagram = (body: object) => ({
      title: 'Flow',
      type: 'diagram',
      content: JSON.stringify(body),
    });

    await expect(
      make({ title: 'Flow', type: 'diagram', content: 'graph TD; A-->B' }),
    ).rejects.toMatchObject({ statusCode: 400, message: /given as JSON/ });
    // A line to a node that does not exist is refused, naming where it is and what does exist.
    await expect(
      make(
        diagram({
          nodes: [
            { id: 'web', label: 'Web' },
            { id: 'api', label: 'API', group: 'back' },
          ],
          edges: [{ from: 'web', to: 'db' }],
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(
        /nodes\.1\.group: No group has the id "back"\. There are none\..*edges\.0\.to: No node has the id "db"\. They are "web", "api"\./,
      ),
    });
    await expect(
      make(
        diagram({
          nodes: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'Again' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ message: /nodes\.1\.id: "a" is the id of another/ });
    await expect(make(diagram({ nodes: [{ id: 'a', label: 'A', x: 10 }] }))).rejects.toMatchObject({
      message: /both x and y/,
    });
    await expect(
      make(diagram({ nodes: [{ id: 'a', label: 'A', colour: 'blue' }] })),
    ).rejects.toMatchObject({ message: /colour/ });

    // Places are optional: the frame lays out what has none, and the source is kept as written.
    const content = JSON.stringify({
      nodes: [
        { id: 'web', label: 'Web' },
        { id: 'api', label: 'API', x: 200, y: 40, shape: 'diamond', color: 'teal' },
      ],
      edges: [{ from: 'web', to: 'api', label: 'calls', style: 'dashed' }],
    });
    const made = await make({ title: 'Flow', type: 'diagram', content });
    expect((await app.inject({ url: at(`/${made.id}/versions/1`), headers })).json().content).toBe(
      content,
    );

    // The owner's own save is held to the same form.
    const save = (body: string) =>
      app.inject({
        method: 'POST',
        url: at(`/${made.id}/versions`),
        headers,
        payload: { version: 1, content: body },
      });
    expect((await save('{"nodes": [], "edges": [{"from": "x", "to": "y"}]}')).statusCode).toBe(400);
    const moved = '{"nodes": [{"id": "web", "label": "Web", "x": 0, "y": 0}]}';
    expect((await save(moved)).statusCode).toBe(201);
    const read = await services.artifacts.read(owner.id, session.id, { artifactId: made.id });
    expect(read).toMatchObject({ version: 2, writtenBy: 'owner', content: moved });
  });

  it('keeps a spreadsheet as CSV, its formulas included', async () => {
    const { app, at, make } = await setup();
    const sheet = await make({
      title: 'Costs',
      type: 'sheet',
      content: 'Item,Cost\nA,2\nB,3\nTotal,=SUM(B2:B3)\n',
    });
    expect(
      (await app.inject({ url: at(`/${sheet.id}/versions/1`), headers })).json().content,
    ).toContain('=SUM(B2:B3)');
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
        "frame-src 'none'",
        "frame-ancestors 'none'",
        // The page saves its own downloads and opens its links to Jian in a tab of their own;
        // the Artifact's frame is given scripts alone, which no flag here widens.
        'sandbox allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox',
      ]),
    );
    expect(policy).not.toMatch(/allow-same-origin|allow-top|unsafe-eval|https?:|\*/);
    expect(page.body).toContain('<iframe id="artifact" sandbox="allow-scripts" ');
    // The source arrives as data, and what it holds never reads as the page's own markup.
    expect(page.body).toContain('Hello \\u003c/script&#62;\\u003cscript&#62;alert(1)');
    expect(page.body).not.toContain('<script>alert(1)');
    expect(page.body).not.toContain('<b>title</b>');
    // It runs in a frame of its own, under a shell whose `frame-src 'none'` refuses every
    // navigation of that frame: a script or a meta refresh cannot take it to an address.
    expect(page.body).toMatch(/<iframe id="artifact" sandbox="allow-scripts"[^>]* srcdoc="/);
    expect(page.body.match(/<iframe/g)).toHaveLength(1);
    // What the agent wrote runs in that frame, so it may not take the whole screen.
    expect(page.body).not.toContain('allowfullscreen');
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

  // What the files hold is in artifact-export.test.ts, which needs a browser. Everything here is
  // refused before one is started.
  it('draws a deck into a file for its owner alone, and only what a deck has', async () => {
    const { services, app, owner, at, make, setVisibility } = await setup();
    const deck = await make({
      title: 'Plan',
      type: 'deck',
      slides: ['A', 'B'].map((text) => `<!doctype html><html><body>${text}</body></html>`),
    });
    const page = await make({ title: 'Page', type: 'html', content: '<p>Hello</p>' });
    const file = (id: string, query: string, version = 1) =>
      at(`/${id}/versions/${version}/export?${query}`);
    const answered = async (url: string, authorization = headers.authorization) => {
      const answer = await app.inject({ url, headers: { authorization } });
      return `${answer.statusCode} ${answer.json().error}`;
    };

    expect((await app.inject({ url: file(deck.id, 'format=pdf') })).statusCode).toBe(401);
    // A public link is proof of its own page and files alone (below), never of the owner's.
    const { publicPath } = (await setVisibility(deck.id, 'public')).json();
    const secret = publicPath.split('/').at(-1);
    expect(await answered(file(deck.id, 'format=pdf'), `Bearer ${secret}`)).toMatch(/^401 /);
    // Nor of what the owner's files have and its own do not: a picture of one slide.
    expect(await answered(`${publicPath}/export?format=png`)).toBe('400 Invalid request');
    expect(await answered(`${publicPath}/export?format=pdf&slide=1`)).toBe('400 Invalid request');

    // Nor through another conversation, with the credential.
    const elsewhere = await services.sessions.createSession(owner.id, { channel: 'api' });
    expect(await answered(at(`/${deck.id}/versions/1/export?format=pdf`, elsewhere.id))).toMatch(
      /^404 /,
    );
    expect(await answered(file(deck.id, 'format=pdf', 2))).toMatch(/^404 /);

    expect(await answered(file(page.id, 'format=pdf'))).toMatch(/^400 Only a deck/);
    expect(await answered(file(deck.id, 'format=png'))).toMatch(/^400 .*say which/);
    expect(await answered(file(deck.id, 'format=png&slide=3'))).toMatch(
      /^400 The deck has 2 slides, so there is no slide 3/,
    );
    for (const query of [
      '',
      'format=gif',
      'format=pdf&fonts=comic',
      'format=png&slide=0',
      'format=png&slide=first',
      'format=pdf&to=https://example.test',
    ]) {
      expect(await answered(file(deck.id, query))).toBe('400 Invalid request');
    }
  });

  it('draws no deck on the gateway a desktop app runs, which has no browser to', async () => {
    const { app, at, make } = await setup('local');
    const deck = await make({
      title: 'Plan',
      type: 'deck',
      slides: ['<!doctype html><html><body>A</body></html>'],
    });

    const refused = await app.inject({
      url: at(`/${deck.id}/versions/1/export?format=pdf`),
      headers,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/only on a server gateway/);
    // The deck itself is read there as anywhere.
    expect((await app.inject({ url: at(`/${deck.id}/versions/1`), headers })).statusCode).toBe(200);
  });
});

describe('the frame the panel draws one in', () => {
  it('holds no Artifact, is kept only by the panel, and reaches nothing', async () => {
    const { app, make } = await setup();
    await make({ title: 'Secret plan', type: 'markdown', content: 'Only for the owner' });

    for (const type of ['html', 'react', 'markdown', 'mermaid', 'deck', 'sheet', 'diagram']) {
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

    // A page and a slide are pages already: the shell makes the frame out of the source it is
    // handed, sealed like any other, and says nothing to anyone.
    for (const type of ['html', 'deck']) {
      const own = (await app.inject({ url: `/v1/artifact-frames/${type}` })).body;
      expect(own).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|postMessage/);
      expect(own).not.toContain('contenteditable');
      expect(own).not.toContain('<iframe');
      expect(own).toContain("frame.setAttribute('sandbox', 'allow-scripts')");
      expect(own).toContain('frame.srcdoc = source');
      // A frame that loads a second time went somewhere, and is removed. Writing a page over a
      // loaded one is such a second load, so nothing here does: it left every page white.
      expect(own).toContain('frame.remove()');
      expect(own).not.toMatch(/document\.(open|write)/);
      expect(own).not.toContain('allowfullscreen');
    }
    // The others are drawn by a page of the gateway's, which the shell posts the source on to.
    // A component's shell says something back: its tweaks, under that one key. Of what can fail
    // as it runs, a component, a diagram and a document, the shell relays what went wrong, once,
    // under its own key. A sheet's says nothing.
    for (const type of ['react', 'markdown', 'mermaid', 'sheet', 'diagram']) {
      const own = (await app.inject({ url: `/v1/artifact-frames/${type}` })).body.replace(
        /srcdoc="[^"]*"/,
        '',
      );
      expect(own.match(/postMessage/g)).toHaveLength({ react: 3, sheet: 1 }[type] ?? 2);
      if (type === 'react')
        expect(own).toContain('parent.postMessage({ jianArtifactTweaks: said }');
      if (type !== 'sheet') {
        expect(own).toContain('parent.postMessage({ jianArtifactError: said }');
        expect(own).toContain('if (!said || reported) return;');
      }
      expect(own).toContain('frame.contentWindow.postMessage');
      expect(own).toContain('frame.remove()');
      expect(own).not.toMatch(/document\.(open|write)|allowfullscreen/);
    }

    expect((await app.inject({ url: '/v1/artifact-frames/python' })).statusCode).toBe(400);
  });

  it('edits in a frame of its own, as sealed, that only answers its parent', async () => {
    const { app } = await setup();

    for (const type of ['html', 'deck', 'markdown', 'sheet', 'diagram']) {
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
      // It sits in a shell, so no navigation of the editing page is allowed either.
      expect(policy.split('; ')).toContain("frame-src 'none'");
      expect(frame.body).toMatch(/<iframe id="artifact" sandbox="allow-scripts"[^>]* srcdoc="/);
      // The shell relays the panel inward and out only the edit key, to its parent and no one else.
      expect(frame.body.replace(/srcdoc="[^"]*"/, '').match(/postMessage/g)).toHaveLength(2);
      expect(frame.body).toContain('frame.contentWindow.postMessage');
      expect(frame.body).toContain('event.source !== frame.contentWindow');
      expect(frame.body).toContain(`parent.postMessage({ ["${ARTIFACT_EDIT_MESSAGE}"]: said }`);
      expect(frame.body).toContain('frame.remove()');
      const inner = (/srcdoc="([^"]*)"/.exec(frame.body)?.[1] ?? '').replace(
        /&#(\d+);/g,
        (_, code) => String.fromCharCode(Number(code)),
      );
      // The page hands the edit to the panel that holds it and to no one else, and reaches nothing.
      // It says to its parent that something changed, and hands the page over when asked: both
      // to `parent`, and nothing else is ever posted.
      expect(inner.match(/postMessage/g)?.length).toBe(
        inner.match(/parent\.postMessage\(/g)?.length,
      );
      expect(inner).toContain('parent.postMessage(');
      expect(inner).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|\.submit\(/);
      // What it is handed is read as a document or as data, never written into the page to run.
      expect(inner).not.toMatch(/document\.write|eval\(|new Function/);
      if (['html', 'deck', 'markdown'].includes(type)) expect(inner).toContain('new DOMParser()');
    }

    // The types the owner does not edit by hand have no such frame.
    for (const type of ['react', 'mermaid']) {
      expect((await app.inject({ url: `/v1/artifact-frames/${type}?edit=1` })).statusCode).toBe(
        400,
      );
    }
    expect((await app.inject({ url: '/v1/artifact-frames/html?edit=yes' })).statusCode).toBe(400);
    // Presenting is a deck's alone, and never while it is edited.
    expect((await app.inject({ url: '/v1/artifact-frames/html?present=1' })).statusCode).toBe(400);
    expect(
      (await app.inject({ url: '/v1/artifact-frames/deck?present=1&edit=1' })).statusCode,
    ).toBe(400);
  });

  it("paints a slide's white inside the deck's frames, and no other frame's", async () => {
    const { app } = await setup();
    // The shell's own page, without the one it holds.
    const shell = async (url: string) =>
      (await app.inject({ url })).body.replace(/srcdoc="[^"]*"/, '');
    // Once the slide's frame has loaded (artifact-frames.test.ts sees it in a browser).
    const sheet = 'html.drawn { background: #fff; }';

    // The panel rounds a slide's corners and paints nothing under its frame (deck/slide-frame.tsx).
    expect(await shell('/v1/artifact-frames/deck')).toContain(sheet);
    expect(await shell('/v1/artifact-frames/deck?edit=1')).toContain(sheet);
    expect(await shell('/v1/artifact-frames/deck?present=1')).not.toContain(sheet);
    expect(await shell('/v1/artifact-frames/html')).not.toContain(sheet);
    expect(await shell('/v1/artifact-frames/markdown?edit=1')).not.toContain(sheet);
  });

  it('serves a deck its player, already presenting, and relays only the end back', async () => {
    const { app } = await setup();
    const frame = await app.inject({ url: '/v1/artifact-frames/deck?present=1' });
    expect(frame.statusCode).toBe(200);
    // The same policy as every frame: nothing loads, and the shell is where frames are checked.
    const policy = String(frame.headers['content-security-policy']);
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain('sandbox allow-scripts');
    // The frame may not take the screen: the panel takes it for the layer that holds the frame.
    expect(frame.body).not.toMatch(/allowfullscreen/);
    const inner = (/srcdoc="([^"]*)"/.exec(frame.body)?.[1] ?? '').replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(Number(code)),
    );
    // The player the public link runs, saying one thing to the panel and asking for no screen.
    expect(inner).toContain('prefers-reduced-motion: reduce');
    expect(inner).toContain("parent.postMessage({ jianArtifactPresent: 'end' }");
    expect(inner.match(/postMessage/g)).toHaveLength(1);
    expect(inner).not.toContain('requestFullscreen');
    expect(inner).toContain("setAttribute('sandbox', 'allow-scripts')");
    // The shell relays the end key out, and no other.
    expect(frame.body).toContain('"jianArtifactPresent"');
    expect(frame.body).not.toContain('jianArtifactEdit');
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
    // The frame the shell holds runs the gateway's player, which may take the whole screen to
    // present; a slide, which is what the agent wrote, is a frame inside it with no such leave.
    expect(page.body).toMatch(
      /<iframe id="artifact" sandbox="allow-scripts"[^>]* allowfullscreen /,
    );
    // The deck runs in the frame the shell holds, written into its `srcdoc`.
    const inner = (/srcdoc="([^"]*)"/.exec(page.body)?.[1] ?? '').replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(Number(code)),
    );
    expect(inner).toContain('Second');
    expect(inner).not.toContain('<script>alert(1)');
    // Each slide is a frame written into the page, as sealed as the page.
    expect(inner).toContain("setAttribute('sandbox', 'allow-scripts')");
    expect(inner).not.toMatch(/postMessage|contenteditable|jian-edit|fetch\(/i);
    expect(inner).not.toMatch(/allowfullscreen|setAttribute\('allow'|\.allow\b/);
    // It is presented from the page itself, and asks for less motion where the reader does.
    expect(inner).toContain('requestFullscreen');
    expect(inner).toContain('prefers-reduced-motion: reduce');
    // A link reads, with or without asking for the editing frame.
    expect((await app.inject({ url: `${publicPath}?edit=1` })).body).toBe(page.body);
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

  it('keeps one editing stretch as one version, and never writes over the agent’s', async () => {
    const { services, app, owner, session, at, make } = await setup();
    const html = await make({ title: 'Page', type: 'html', content: page('Agent') });
    const save = (artifactId: string, payload: object) =>
      app.inject({ method: 'POST', url: at(`/${artifactId}/versions`), headers, payload });
    const content = async (artifactId: string, number: number) =>
      sessionArtifactVersionSchema.parse(
        (await app.inject({ url: at(`/${artifactId}/versions/${number}`), headers })).json(),
      ).content;
    const stretch = 'stretch-one-key';

    // The first save of a stretch adds the owner's version; the next ones replace its content.
    expect(
      (await save(html.id, { version: 1, content: page('a'), editKey: stretch })).json(),
    ).toMatchObject({ version: 2 });
    expect(
      (await save(html.id, { version: 2, content: page('ab'), editKey: stretch })).json(),
    ).toMatchObject({ version: 2 });
    expect(
      (await save(html.id, { version: 2, content: page('abc'), editKey: stretch })).json(),
    ).toMatchObject({ version: 2 });
    expect(await content(html.id, 2)).toBe(page('abc'));
    expect(await content(html.id, 1)).toBe(page('Agent'));

    // Another stretch is another version, even with nothing between.
    expect(
      (
        await save(html.id, { version: 2, content: page('next'), editKey: 'stretch-two-key' })
      ).json(),
    ).toMatchObject({ version: 3 });
    expect(await content(html.id, 2)).toBe(page('abc'));

    // Without a key every save is a version, as before.
    expect((await save(html.id, { version: 3, content: page('plain') })).json()).toMatchObject({
      version: 4,
    });
    expect((await save(html.id, { version: 4, content: page('plain 2') })).json()).toMatchObject({
      version: 5,
    });

    // The agent wrote on top meanwhile: the stretch's next save is a new version above it, and
    // the agent's is as it wrote it.
    await services.artifacts.revise(owner.id, session.id, {
      artifactId: html.id,
      content: page('Agent again'),
    });
    const late = await save(html.id, {
      version: 5,
      content: page('late'),
      editKey: 'stretch-two-key',
    });
    expect(late.json()).toMatchObject({ version: 7 });
    expect(await content(html.id, 6)).toBe(page('Agent again'));
    expect(await content(html.id, 7)).toBe(page('late'));

    // A key the agent's version never had cannot be replayed to overwrite it either.
    await services.artifacts.revise(owner.id, session.id, {
      artifactId: html.id,
      content: page('Agent 3'),
    });
    await save(html.id, { version: 8, content: page('grab'), editKey: 'stretch-two-key' });
    expect(await content(html.id, 8)).toBe(page('Agent 3'));

    // A deck keeps the slides it already changed in the stretch.
    const deck = await make({ title: 'Plan', type: 'deck', slides: [slide('A'), slide('B')] });
    await save(deck.id, { version: 1, slide: 1, content: slide('A1'), editKey: stretch });
    const again = await save(deck.id, {
      version: 2,
      slide: 2,
      content: slide('B1'),
      editKey: stretch,
    });
    expect(again.json()).toMatchObject({ version: 2 });
    expect(await content(deck.id, 2)).toContain('B1');
    expect(await content(deck.id, 2)).toContain('A1');

    // A paired phone still cannot edit, with a key or without.
    const pairing = await app.inject({ method: 'POST', url: '/v1/devices/pairings', headers });
    const phone = (
      await app.inject({
        method: 'POST',
        url: '/v1/devices/pair',
        payload: { code: pairing.json().code, name: 'Pixel', platform: 'android' },
      })
    ).json() as { token: string };
    const refused = await app.inject({
      method: 'POST',
      url: at(`/${html.id}/versions`),
      headers: { authorization: `Bearer ${phone.token}` },
      payload: { version: 9, content: page('phone'), editKey: stretch },
    });
    expect(refused.statusCode).toBe(403);
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

    // A paired phone reads the conversation but never edits by hand.
    const pairing = await app.inject({ method: 'POST', url: '/v1/devices/pairings', headers });
    const phone = (
      await app.inject({
        method: 'POST',
        url: '/v1/devices/pair',
        payload: { code: pairing.json().code, name: 'Pixel', platform: 'android' },
      })
    ).json() as { token: string };
    const device = { authorization: `Bearer ${phone.token}` };
    expect((await app.inject({ url: at(), headers: device })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, headers: device, payload })).statusCode).toBe(
      403,
    );
    // Nor publishes one: a public link is the owner's call, from the panel.
    const share = { visibility: 'public' };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: at(`/${html.id}`),
          headers: device,
          payload: share,
        })
      ).statusCode,
    ).toBe(403);

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
    const diagram = await make({ title: 'Flow', type: 'mermaid', content: 'graph TD; A-->B' });
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
    expect(await save(diagram.id, { version: 1, content: 'graph TD; B-->A' })).toBe(409);
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

describe('what the owner builds of a deck by hand', () => {
  /** A paired phone's credential: it reads the conversation as the owner does. */
  async function phoneOf(app: FastifyInstance) {
    const pairing = await app.inject({ method: 'POST', url: '/v1/devices/pairings', headers });
    const phone = (
      await app.inject({
        method: 'POST',
        url: '/v1/devices/pair',
        payload: { code: pairing.json().code, name: 'Pixel', platform: 'android' },
      })
    ).json() as { token: string };
    return { authorization: `Bearer ${phone.token}` };
  }

  it('adds, copies, moves and deletes slides as versions of the owner’s', async () => {
    const { app, at, make } = await setup();
    const deck = await make({ title: 'Plan', type: 'deck', slides: [slide('A'), slide('B')] });
    const change = (payload: object) =>
      app.inject({ method: 'POST', url: at(`/${deck.id}/slides`), headers, payload });
    const version = async (number: number) =>
      sessionArtifactVersionSchema.parse(
        (await app.inject({ url: at(`/${deck.id}/versions/${number}`), headers })).json(),
      );

    const added = await change({ op: 'add', version: 1, html: slide('New'), position: 2 });
    expect(added.statusCode).toBe(201);
    expect(sessionArtifactSchema.parse(added.json())).toMatchObject({ id: deck.id, version: 2 });
    expect(await version(2)).toMatchObject({
      author: 'owner',
      slides: [slide('A'), slide('New'), slide('B')],
    });
    // At the end without a place named.
    expect((await change({ op: 'add', version: 2, html: slide('End') })).json()).toMatchObject({
      version: 3,
    });
    // A copy comes right after the slide it was made of.
    expect((await change({ op: 'duplicate', version: 3, slide: 1 })).json()).toMatchObject({
      version: 4,
    });
    expect((await version(4)).slides).toEqual([
      slide('A'),
      slide('A'),
      slide('New'),
      slide('B'),
      slide('End'),
    ]);
    expect((await change({ op: 'move', version: 4, slide: 5, to: 1 })).statusCode).toBe(201);
    expect((await change({ op: 'delete', version: 5, slide: 2 })).statusCode).toBe(201);
    expect((await version(6)).slides).toEqual([slide('End'), slide('A'), slide('New'), slide('B')]);

    // Made from the version the owner was looking at, as an edit is: an older one comes back
    // with the change, and every version between stays as it was.
    expect((await change({ op: 'delete', version: 1, slide: 1 })).json()).toMatchObject({
      version: 7,
    });
    expect((await version(7)).slides).toEqual([slide('B')]);
    expect((await version(6)).slides).toHaveLength(4);
  });

  it('builds on the stretch the owner is editing, and never writes over the agent’s', async () => {
    const { services, app, owner, session, at, make } = await setup();
    const deck = await make({ title: 'Plan', type: 'deck', slides: [slide('A'), slide('B')] });
    const post = (rest: string, payload: object) =>
      app.inject({ method: 'POST', url: at(`/${deck.id}${rest}`), headers, payload });
    const slides = async (number: number) =>
      sessionArtifactVersionSchema.parse(
        (await app.inject({ url: at(`/${deck.id}/versions/${number}`), headers })).json(),
      ).slides;
    const stretch = 'stretch-of-slides';

    // A slide's text edited in a stretch, then a slide added with the stretch's key: the same
    // version, holding both, though the add names the version the stretch started from.
    await post('/versions', {
      version: 1,
      slide: 1,
      content: slide('A, edited'),
      editKey: stretch,
    });
    const joined = await post('/slides', {
      op: 'add',
      version: 1,
      html: slide('C'),
      editKey: stretch,
    });
    expect(joined.json()).toMatchObject({ version: 2 });
    expect(await slides(2)).toEqual([slide('A, edited'), slide('B'), slide('C')]);
    const moved = await post('/slides', {
      op: 'move',
      version: 2,
      slide: 3,
      to: 1,
      editKey: stretch,
    });
    expect(moved.json()).toMatchObject({ version: 2 });
    expect(await slides(2)).toEqual([slide('C'), slide('A, edited'), slide('B')]);

    // Without the key, a change made after the edit was saved builds on the version it names:
    // the owner's, with their text in it.
    const copied = await post('/slides', { op: 'duplicate', version: 2, slide: 2 });
    expect(copied.json()).toMatchObject({ version: 3 });
    expect(await slides(3)).toEqual([
      slide('C'),
      slide('A, edited'),
      slide('A, edited'),
      slide('B'),
    ]);

    // The agent wrote meanwhile: the stretch's key no longer joins anything, and the change is a
    // version above the agent's, which stays as it wrote it.
    await services.artifacts.changeSlide(owner.id, session.id, 'update', {
      artifactId: deck.id,
      slide: 1,
      html: slide('Agent'),
    });
    const late = await post('/slides', { op: 'delete', version: 3, slide: 4, editKey: stretch });
    expect(late.json()).toMatchObject({ version: 5 });
    expect((await slides(4))?.[0]).toBe(slide('Agent'));
    expect(await slides(5)).toEqual([slide('C'), slide('A, edited'), slide('A, edited')]);
  });

  it('keeps at least one slide, and refuses what is not a change it can make', async () => {
    const { services, app, at, make } = await setup();
    const deck = await make({ title: 'Plan', type: 'deck', slides: [slide('Only')] });
    const page = await make({ title: 'Page', type: 'html', content: slide('Page') });
    const diagram = await make({ title: 'Flow', type: 'mermaid', content: 'graph TD; A-->B' });
    const change = (artifactId: string, payload: object) =>
      app.inject({ method: 'POST', url: at(`/${artifactId}/slides`), headers, payload });

    const last = await change(deck.id, { op: 'delete', version: 1, slide: 1 });
    expect(last.statusCode).toBe(400);
    expect(last.body).toContain('keeps at least one slide');
    // It names no tool: the owner has none.
    expect(last.body).not.toContain('update_slide');
    for (const payload of [
      { op: 'delete', version: 1, slide: 2 },
      { op: 'duplicate', version: 1, slide: 2 },
      { op: 'move', version: 1, slide: 1, to: 2 },
      { op: 'add', version: 1, html: slide('x'), position: 3 },
      { op: 'add', version: 1, html: '' },
      { op: 'add', version: 1, html: 'x'.repeat(SESSION_ARTIFACT_MAX + 1) },
      { op: 'rotate', version: 1, slide: 1 },
      { op: 'delete', slide: 1 },
      { op: 'delete', version: 1, slide: 1, content: slide('x') },
    ]) {
      expect((await change(deck.id, payload)).statusCode, payload.op).toBe(400);
    }
    const unknown = { op: 'add', version: 2, html: slide('x') };
    expect((await change(deck.id, unknown)).statusCode).toBe(404);
    // Only a deck has slides, and what is not edited by hand is not edited this way either.
    const added = { op: 'add', version: 1, html: slide('x') };
    expect((await change(page.id, added)).statusCode).toBe(400);
    expect((await change(diagram.id, added)).statusCode).toBe(409);

    const versions = await services.store.db
      .select()
      .from(sessionArtifactVersions)
      .where(eq(sessionArtifactVersions.artifactId, deck.id));
    expect(versions).toHaveLength(1);
  });

  it('takes a change only from the owner, through the deck’s own conversation', async () => {
    const { services, app, owner, at, make, setVisibility } = await setup();
    const deck = await make({ title: 'Plan', type: 'deck', slides: [slide('A'), slide('B')] });
    const payload = { op: 'add', version: 1, html: slide('Stranger') };
    const url = at(`/${deck.id}/slides`);

    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    const { publicPath } = (await setVisibility(deck.id, 'public')).json();
    const secret = publicPath.split('/').at(-1);
    const link = { authorization: `Bearer ${secret}` };
    expect((await app.inject({ method: 'POST', url, headers: link, payload })).statusCode).toBe(
      401,
    );

    // A paired phone reads the deck, but builds nothing of it.
    const device = await phoneOf(app);
    expect((await app.inject({ url: at(), headers: device })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, headers: device, payload })).statusCode).toBe(
      403,
    );

    // Another conversation of the same agent, or another agent, finds no such deck.
    const elsewhere = await services.sessions.createSession(owner.id, { channel: 'api' });
    const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
    const theirs = await services.sessions.createSession(other.id, { channel: 'api' });
    for (const [sessionId, profileId] of [
      [elsewhere.id, owner.id],
      [theirs.id, other.id],
      [deck.sessionId, other.id],
    ] as const) {
      const refused = await app.inject({
        method: 'POST',
        url: at(`/${deck.id}/slides`, sessionId, profileId),
        headers,
        payload,
      });
      expect(refused.statusCode).toBe(404);
    }

    expect((await app.inject({ url: at(), headers })).json()).toMatchObject([{ version: 1 }]);
    expect((await app.inject({ url: publicPath })).body).not.toContain('Stranger');
  });
});
