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
