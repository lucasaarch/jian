import { existsSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { outsideContent } from '../src/agent/untrusted.js';
import { findMedia } from '../src/media/repository.js';
import { inspectPage, pageInspectionSchema } from '../src/web/inspection.js';
import { WebSearch } from '../src/web/service.js';
import { testServices } from './helpers/services.js';

const available = existsSync(process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? chromium.executablePath());
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBz8AAAAASUVORK5CYII=',
  'base64',
);
const fixture: typeof fetch = async (input, init) => {
  const url = String(input);
  expect(init?.redirect).toBe('manual');
  expect(new Headers(init?.headers).get('authorization')).toBeNull();
  expect(new Headers(init?.headers).get('cookie')).toBeNull();
  if (url === 'https://studio.example.test/design')
    return new Response(null, { status: 302, headers: { location: '/pages/design/index.html' } });
  if (url === 'https://studio.example.test/pages/design/index.html')
    return new Response(
      `<html><head><title>Atlas Studio</title><link rel="stylesheet" href="./site.css"></head><body><h1>Atlas</h1><button id="menu" onclick="document.querySelector('#panel').hidden=false;fetch('/write',{method:'POST'}).catch(()=>{})">Open menu</button><div id="panel" hidden>Expanded menu</div><input id="name" aria-label="Name" oninput="document.querySelector('#greeting').textContent=this.value"><p id="greeting"></p><img src="./mark.png" alt="Atlas mark"><iframe title="Preview" src="https://preview.example.test/frame"></iframe><div style="height:1800px">Footer</div><script>fetch('/read-location').catch(()=>{});</script></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    );
  if (url.endsWith('/site.css'))
    return new Response(
      'body{background:rgb(10,20,30);color:white}h1{font-size:32px}@media(max-width:600px){h1{font-size:20px}}',
      { headers: { 'content-type': 'text/css' } },
    );
  if (url.endsWith('/mark.png'))
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  if (url === 'https://preview.example.test/frame')
    return new Response(
      '<body><button id="tab" onclick="this.textContent=\'Selected tab\'">Tab</button><canvas width="10" height="10"></canvas></body>',
      { headers: { 'content-type': 'text/html' } },
    );
  if (url === 'https://studio.example.test/read-location') return Response.json({ ok: true });
  throw new Error('Outbound endpoint is not permitted');
};

it('marks visual inspections as outside content and bounds browser inputs', () => {
  expect(outsideContent('inspect_page', [])).toBe(true);
  expect(
    pageInspectionSchema.safeParse({ url: 'https://example.test', width: 100000 }).success,
  ).toBe(false);
  expect(
    pageInspectionSchema.safeParse({
      url: 'https://example.test',
      actions: [{ type: 'evaluate', code: 'process.env' }],
    }).success,
  ).toBe(false);
});

describe.runIf(available)('visual website inspection', () => {
  it('captures a generic website with its responsive styles, rendered DOM, images and public resources', async () => {
    const inspected = await inspectPage(
      pageInspectionSchema.parse({
        url: 'https://studio.example.test/design',
        width: 500,
        height: 700,
      }),
      fixture,
      AbortSignal.timeout(15000),
    );
    expect(inspected.snapshot.url).toBe('https://studio.example.test/pages/design/index.html');
    expect(inspected.snapshot.title).toBe('Atlas Studio');
    expect(inspected.snapshot.frames.map((frame) => frame.url)).toContain(
      'https://preview.example.test/frame',
    );
    expect(
      inspected.snapshot.frames[0]?.elements.find((element) => element.tag === 'h1')?.styles[
        'font-size'
      ],
    ).toBe('20px');
    expect(inspected.snapshot.frames[0]?.assets).toContainEqual(
      expect.objectContaining({
        url: 'https://studio.example.test/pages/design/mark.png',
        alt: 'Atlas mark',
      }),
    );
    expect(await sharp(inspected.screenshot).metadata()).toMatchObject({
      format: 'jpeg',
      width: 500,
      height: 700,
    });
    const files = unzipSync(inspected.archive);
    expect(Buffer.from(files['frames/0.html'] ?? []).toString()).toContain('id="menu"');
    const manifest = JSON.parse(Buffer.from(files['inspection.json'] ?? []).toString());
    const image = manifest.resources.find(
      (resource: { mimeType: string }) => resource.mimeType === 'image/png',
    );
    expect(Buffer.from(files[image.path] ?? [])).toEqual(png);
    expect(
      manifest.resources.some((resource: { mimeType: string }) => resource.mimeType === 'text/css'),
    ).toBe(true);
    expect(inspected.snapshot.sourceNote).toContain('not the original private project');
  });

  it('replays menu, form, frame and scroll states without persisting a session or allowing network writes', async () => {
    const inspected = await inspectPage(
      pageInspectionSchema.parse({
        url: 'https://studio.example.test/design',
        actions: [
          { type: 'click', selector: '#menu' },
          { type: 'fill', selector: '#name', text: 'Nova' },
          { type: 'click', frame: 1, selector: '#tab' },
          { type: 'scroll', y: 900 },
        ],
      }),
      fixture,
      AbortSignal.timeout(15000),
    );
    expect(inspected.snapshot.frames[0]?.text).toContain('Expanded menu');
    expect(inspected.snapshot.frames[0]?.text).toContain('Nova');
    expect(inspected.snapshot.frames[1]?.text).toContain('Selected tab');
    expect(inspected.snapshot.frames[0]?.scroll.y).toBe(900);
    expect(inspected.snapshot.blocked).toContainEqual(
      expect.objectContaining({ url: 'https://studio.example.test/write' }),
    );
    const fresh = await inspectPage(
      pageInspectionSchema.parse({ url: 'https://studio.example.test/design' }),
      fixture,
      AbortSignal.timeout(15000),
    );
    expect(fresh.snapshot.frames[0]?.text).not.toContain('Expanded menu');
    expect(fresh.snapshot.frames[0]?.text).not.toContain('Nova');
  });

  it('stores inspectable media in the run conversation and supplies real pixels to a vision model', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const session = await services.sessions.createGatewaySession(profile.id, {});
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Inspect this design',
      requestKey: 'inspect-one',
    });
    const web = new WebSearch(services.store, services.gatewayVault, fixture);
    const definition = web.tools(run, true).inspect_page;
    if (!definition?.execute) throw new Error('Inspection tool is not available');
    const result = await (
      definition.execute as (
        input: unknown,
        options: unknown,
      ) => Promise<{ screenshot: { mediaId: string }; archive: { mediaId: string } }>
    )(pageInspectionSchema.parse({ url: 'https://studio.example.test/design' }), {
      toolCallId: 'inspect',
      messages: [],
    });
    const image = await findMedia(services.store.db, profile.id, result.screenshot.mediaId);
    expect(image).toMatchObject({
      profileId: profile.id,
      sessionId: session.id,
      runId: run.id,
      mimeType: 'image/jpeg',
    });
    expect((await findMedia(services.store.db, profile.id, result.archive.mediaId)).mimeType).toBe(
      'application/zip',
    );
    await expect(
      findMedia(services.store.db, '00000000-0000-4000-8000-000000000001', image.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    const output = await definition?.toModelOutput?.({
      output: result,
      input: {},
      toolCallId: 'inspect',
    } as never);
    expect(output).toMatchObject({
      type: 'content',
      value: [
        expect.objectContaining({ type: 'text' }),
        { type: 'image-data', data: image.data, mediaType: 'image/jpeg' },
      ],
    });
    const textOnly = web.tools(run, false).inspect_page;
    expect(
      await textOnly?.toModelOutput?.({
        output: result,
        input: {},
        toolCallId: 'inspect',
      } as never),
    ).toMatchObject({ type: 'json' });
  });
});
