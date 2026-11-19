import { PUBLIC_ARTIFACT_FORMATS } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { drawnInTurn } from '../src/artifacts/public-files.js';
import { sessionArtifacts } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-admin-token-with-32-characters';
const headers = { authorization: `Bearer ${token}` };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(mode: 'server' | 'local' = 'server') {
  const services = await testServices(undefined, undefined, undefined, mode);
  const app = createApp({ ...services, token, logger: false, mode });
  apps.push(app);
  const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const session = await services.sessions.createSession(owner.id, { channel: 'api' });
  const make = (input: object) => services.artifacts.create(owner.id, session.id, input);
  /** Public, and the path its link answers at. */
  const share = async (artifactId: string, visibility: 'private' | 'public' = 'public') =>
    (
      await app.inject({
        method: 'PATCH',
        url: `/v1/profiles/${owner.id}/sessions/${session.id}/artifacts/${artifactId}`,
        headers,
        payload: { visibility },
      })
    ).json().publicPath as string;

  return { services, app, owner, session, make, share };
}

/** The Artifact's own page, as the public page holds it in its frame's `srcdoc`. */
const framed = (page: string) =>
  (/<iframe id="artifact"[^>]* srcdoc="([^"]*)"/.exec(page)?.[1] ?? '').replace(
    /&#(\d+);/g,
    (_, code) => String.fromCharCode(Number(code)),
  );

describe('a public web page', () => {
  const source =
    '<!doctype html><html class="own"><head><style>td { color: teal }</style></head><body><table><tr><td>Cell</td></tr></table></body></html>';

  it('is the agent’s page alone, with none of Jian’s styles over it', async () => {
    const { app, make, share } = await setup();
    const page = await make({ title: 'Table', type: 'html', content: source });
    const body = (await app.inject({ url: await share(page.id) })).body;
    const inner = framed(body);

    // Its markup as written, given only the scheme that follows the reader's system, after its
    // own `html` tag so the tag's class is kept.
    expect(inner).toMatch(
      /^<!doctype html><html class="own"><meta name="color-scheme" content="light dark"><script>/,
    );
    expect(inner).toContain('<style>td { color: teal }</style>');
    // What Jian draws its own types with is nowhere in it.
    expect(inner).not.toMatch(/padding: 16px|th, td \{|#failure|id="root"|document\.write/);
  });

  it('has its toolbar on the page around it, never in its frame', async () => {
    const { app, make, share } = await setup();
    const page = await make({ title: 'Table', type: 'html', content: source });
    const path = await share(page.id);
    const body = (await app.inject({ url: path })).body;
    const secret = path.split('/').at(-1);

    expect(body).toContain('<header id="bar"');
    expect(body).toContain(`href="${secret}/export?format=html"`);
    expect(framed(body)).not.toMatch(/id="bar"|export\?format|Download/);
    // A web page has no prompts to copy; only a component does.
    expect(body).not.toContain('data-target=');
  });
});

describe('a public component', () => {
  it('offers prompts that carry its source as written, not as its frame runs it', async () => {
    const { app, make, share } = await setup();
    const written = 'export default function Hello() {\n  return <p>Hello</p>;\n}\n';
    const component = await make({ title: 'Hello', type: 'react', content: written });
    const body = (await app.inject({ url: await share(component.id) })).body;

    for (const target of ['react', 'vue', 'angular', 'svelte', 'solid', 'html', 'react-native']) {
      expect(body).toContain(`data-target="${target}"`);
    }
    const prompt = JSON.parse(
      /<script type="application\/json" id="prompt">(.*?)<\/script>/s.exec(body)?.[1] ?? '{}',
    );
    expect(prompt.source).toBe(written);
    expect(prompt.parts.vue[0]).toContain('Vue 3 single-file component');
    // The frame runs it compiled, and the prompt is not that.
    expect(framed(body)).toContain('exports.default');
    expect(prompt.source).not.toContain('exports.default');
  });
});

describe('a public link’s files', () => {
  const file = (app: FastifyInstance, path: string, format: string) =>
    app.inject({ url: `${path}/export?format=${format}` });

  it('answers the latest version, to anyone holding the link, as an attachment', async () => {
    const { services, app, owner, session, make, share } = await setup();
    const page = await make({
      title: 'Relatório "Q3" / São Paulo',
      type: 'html',
      content: '<p>First</p>',
    });
    const path = await share(page.id);

    const first = await file(app, path, 'html');
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe('<p>First</p>');
    expect(first.headers['content-type']).toBe('text/html; charset=utf-8');
    // Saved, never drawn at the gateway's address: an attachment, sealed if it were drawn.
    expect(first.headers['content-disposition']).toBe(
      `attachment; filename="Relatorio-Q3-Sao-Paulo.html"; filename*=UTF-8''Relat%C3%B3rio-Q3-S%C3%A3o-Paulo.html`,
    );
    expect(String(first.headers['content-security-policy'])).toContain('sandbox');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.headers['cache-control']).toBe('no-store');

    await services.artifacts.revise(owner.id, session.id, {
      artifactId: page.id,
      content: '<p>Second</p>',
    });
    expect((await file(app, path, 'html')).body).toBe('<p>Second</p>');
  });

  it('answers only the formats its type offers, drawn without a browser where it can be', async () => {
    const { app, make, share } = await setup();
    const written = 'export default function Hi() {\n  return <p>Hi</p>;\n}\n';
    const component = await share(
      (await make({ title: 'Hi', type: 'react', content: written })).id,
    );
    const sheet = await share(
      (
        await make({
          title: 'Costs',
          type: 'sheet',
          content: 'Item,Cost\nA,2\nB,3\nTotal,=SUM(B2:B3)\n',
        })
      ).id,
    );

    // A component is its source as written.
    expect((await file(app, component, 'tsx')).body).toBe(written);
    // A spreadsheet's values, worked out, and an Excel file.
    expect((await file(app, sheet, 'csv')).body).toContain('Total,5');
    const xlsx = await file(app, sheet, 'xlsx');
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(xlsx.headers['content-disposition']).toContain('filename="Costs.xlsx"');

    expect(PUBLIC_ARTIFACT_FORMATS.react).not.toContain('pdf');
    const refused = await file(app, component, 'pdf');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/not downloaded as PDF/);
    for (const format of ['png', 'exe', '']) {
      expect((await file(app, component, format)).statusCode).toBe(400);
    }
  });

  it('answers nothing for a private, unknown or past link', async () => {
    const { app, make, share } = await setup();
    const page = await make({ title: 'Page', type: 'html', content: '<p>Kept</p>' });

    expect((await file(app, `/v1/public-artifacts/${'A'.repeat(43)}`, 'html')).statusCode).toBe(
      404,
    );
    const path = await share(page.id);
    expect((await file(app, path, 'html')).statusCode).toBe(200);
    await share(page.id, 'private');
    expect((await file(app, path, 'html')).statusCode).toBe(404);
    // Public again is another link; the one shared before stays dead.
    const again = await share(page.id);
    expect((await file(app, path, 'html')).statusCode).toBe(404);
    expect((await file(app, again, 'html')).body).toBe('<p>Kept</p>');
  });

  it('answers nothing on the gateway a desktop app runs', async () => {
    const { services, app, make } = await setup('local');
    const page = await make({ title: 'Page', type: 'html', content: '<p>Kept</p>' });
    const secret = 'B'.repeat(43);
    await services.store.db
      .update(sessionArtifacts)
      .set({ visibility: 'public', publicToken: secret })
      .where(eq(sessionArtifacts.id, page.id));

    expect((await file(app, `/v1/public-artifacts/${secret}`, 'html')).statusCode).toBe(404);
  });
});

describe('a public link with a password', () => {
  const form = (app: FastifyInstance, path: string, password: string) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ password }).toString(),
    });
  /** The pass a right password answered, as the browser sends its cookie back. */
  const cookieOf = (answer: { headers: Record<string, unknown> }) =>
    String(answer.headers['set-cookie']).split(';')[0] as string;

  async function guarded(password = 'open sesame') {
    const context = await setup();
    const page = await context.make({ title: 'Secret plan', type: 'html', content: '<p>Plan</p>' });
    const path = await context.share(page.id);
    const set = await context.app.inject({
      method: 'PATCH',
      url: `/v1/profiles/${context.owner.id}/sessions/${context.session.id}/artifacts/${page.id}`,
      headers,
      payload: { password },
    });
    expect(set.json()).toMatchObject({ passwordProtected: true });

    return { ...context, page, path, secret: path.split('/').at(-1) as string };
  }

  it('asks for it first, and tells nothing of the Artifact until it is given', async () => {
    const { app, path, secret } = await guarded();
    const locked = await app.inject({ url: path });

    expect(locked.statusCode).toBe(401);
    expect(locked.headers['cache-control']).toBe('no-store');
    expect(String(locked.headers['content-security-policy'])).toContain("form-action 'self'");
    expect(locked.body).toContain('<form class="glass-strong" method="post">');
    expect(locked.body).toContain('type="password"');
    expect(locked.body).not.toMatch(/Secret plan|<p>Plan<\/p>|<script|<iframe/);
    // Nor are its files given without it.
    expect((await app.inject({ url: `${path}/export?format=html` })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: `${path}/export?format=html&pass=9999999999.forged` })).statusCode,
    ).toBe(401);

    const wrong = await form(app, path, 'not it');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect(wrong.body).toContain('That password is not right.');

    const right = await form(app, path, 'open sesame');
    expect(right.statusCode).toBe(303);
    expect(right.headers.location).toBe(secret);
    expect(String(right.headers['set-cookie'])).toMatch(
      /^jian_artifact_[0-9a-f]{16}=\d+\.[\w-]+; Max-Age=86400; HttpOnly; SameSite=Lax$/,
    );

    // With the pass, the page and its files as for any public link; the page's downloads carry
    // the pass, since its sandboxed page sends no cookie.
    const cookie = cookieOf(right);
    const open = await app.inject({ url: path, headers: { cookie } });
    expect(open.statusCode).toBe(200);
    expect(open.body).toContain('Secret plan');
    const pass = cookie.split('=')[1] as string;
    expect(open.body).toContain(`href="${secret}/export?format=html&#38;pass=${pass}"`);
    expect((await app.inject({ url: `${path}/export?format=html&pass=${pass}` })).body).toBe(
      '<p>Plan</p>',
    );
    expect(
      (await app.inject({ url: `${path}/export?format=html`, headers: { cookie } })).statusCode,
    ).toBe(200);
  });

  it('ends every pass when the owner changes it or takes it away', async () => {
    const { app, owner, session, page, path } = await guarded();
    const cookie = cookieOf(await form(app, path, 'open sesame'));
    const change = (password: string | null) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/profiles/${owner.id}/sessions/${session.id}/artifacts/${page.id}`,
        headers,
        payload: { password },
      });

    // Too short to be kept.
    expect((await change('abc')).statusCode).toBe(400);
    await change('another one');
    expect((await app.inject({ url: path, headers: { cookie } })).statusCode).toBe(401);
    expect((await form(app, path, 'open sesame')).statusCode).toBe(401);
    expect((await form(app, path, 'another one')).statusCode).toBe(303);

    // None: the link opens for anyone again, and the form has nothing to ask.
    expect((await change(null)).json()).toMatchObject({ passwordProtected: false });
    expect((await app.inject({ url: path })).statusCode).toBe(200);
    const unasked = await form(app, path, 'anything');
    expect(unasked.statusCode).toBe(303);
    expect(unasked.headers['set-cookie']).toBeUndefined();
  });

  it('stays with the Artifact across a new link, and never goes with a copy', async () => {
    const { app, owner, session, page, share } = await guarded();
    await share(page.id, 'private');
    const again = await share(page.id);
    expect((await app.inject({ url: again })).statusCode).toBe(401);

    const copied = await app.inject({
      method: 'POST',
      url: `/v1/profiles/${owner.id}/sessions/${session.id}/artifacts/${page.id}/duplicate`,
      headers,
    });
    expect(copied.json()).toMatchObject({ passwordProtected: false });
  });

  it('takes ten tries a minute from one reader', async () => {
    const { app, path } = await guarded();
    const tries = [];
    for (let at = 0; at < 11; at += 1) tries.push((await form(app, path, 'guess')).statusCode);

    expect(tries.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(tries[10]).toBe(429);
  });
});

describe('a public file drawn by the browser', () => {
  /** A drawing that ends when the test says. */
  const held = () => {
    let end: () => void = () => {};
    const done = new Promise<string>((resolve) => {
      end = () => resolve('drawn');
    });
    return { done, end };
  };

  it('is drawn once at a time per link, and only a few at once across them', async () => {
    const first = held();
    const second = held();
    const drawing = drawnInTurn('link-a', 'pdf', () => first.done);

    // The same link again, while its file is drawn: refused at once, not queued.
    await expect(drawnInTurn('link-a', 'pptx', async () => 'again')).rejects.toMatchObject({
      statusCode: 429,
    });
    // What needs no browser is never held up.
    await expect(drawnInTurn('link-a', 'csv', async () => 'plain')).resolves.toBe('plain');
    const other = drawnInTurn('link-b', 'pdf', () => second.done);
    // Two are being drawn: a third link waits for neither.
    await expect(drawnInTurn('link-c', 'pdf', async () => 'third')).rejects.toMatchObject({
      statusCode: 429,
    });

    first.end();
    second.end();
    expect(await Promise.all([drawing, other])).toEqual(['drawn', 'drawn']);
    // Once drawn, the link draws again; a failed drawing frees it too.
    await expect(
      drawnInTurn('link-a', 'pdf', async () => {
        throw new Error('The browser closed.');
      }),
    ).rejects.toThrow('The browser closed.');
    await expect(drawnInTurn('link-a', 'pdf', async () => 'again')).resolves.toBe('again');
  });
});
