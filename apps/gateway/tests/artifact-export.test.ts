import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deckExportSchema, SLIDE_HEIGHT, SLIDE_WIDTH } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { exportDeck } from '../src/artifacts/export.js';
import { testServices } from './helpers/services.js';

// How the gateway confines its browser belongs to web/browser.ts and to the machine it runs on:
// Chromium's own sandbox does not start inside most containers. Here the browser is only
// started, plainly; what an export lets a slide reach, and the files it makes, are what is tested.
vi.mock('../src/web/browser.js', async (original) => ({
  ...(await original<typeof import('../src/web/browser.js')>()),
  launchChromium: async () => {
    const { chromium } = await import('playwright');

    return chromium.launch({
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? chromium.executablePath(),
    });
  },
}));

const token = 'synthetic-admin-token-with-32-characters';
const headers = { authorization: `Bearer ${token}` };

/** A slide of one colour, with something to read on it. */
const slide = (colour: string, text: string) =>
  `<!doctype html><html><body style="margin:0;background:${colour}"><h1>${text}</h1></body></html>`;
const SLIDES = [
  slide('#ff0000', 'Opening'),
  slide('#00ff00', 'Q&amp;A &lt;now&gt;'),
  slide('#0000ff', 'Closing'),
];

/** The colour a picture begins with, and its size in device pixels. */
async function seen(png: Buffer) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });

  return { size: [info.width, info.height], colour: [data[0], data[1], data[2]] };
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// Production images include Chromium. A source checkout can run these with `playwright install chromium`.
describe.runIf(existsSync(process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? chromium.executablePath()))(
  'a deck drawn into a file',
  // A browser is started for every file, and some of these make three.
  { timeout: 60_000 },
  () => {
    it('is a PDF with a page for every slide, each the slide’s own shape', async () => {
      const { mimeType, data } = await exportDeck('Plan', SLIDES, { format: 'pdf' });
      const pdf = data.toString('latin1');

      expect(mimeType).toBe('application/pdf');
      expect(pdf.startsWith('%PDF-')).toBe(true);
      expect(pdf.match(/\/Type\s*\/Page\b/g)).toHaveLength(SLIDES.length);
      // Every page has one box, in points: three quarters of a CSS pixel.
      expect([...new Set(pdf.match(/\/MediaBox\s*\[[^\]]*\]/g))]).toEqual([
        `/MediaBox [0 0 ${SLIDE_WIDTH * 0.75} ${SLIDE_HEIGHT * 0.75}]`,
      ]);
    });

    it('is a picture of the one slide, at twice its canvas', async () => {
      const { mimeType, data } = await exportDeck('Plan', SLIDES.slice(1, 2), { format: 'png' });

      expect(mimeType).toBe('image/png');
      expect(await seen(data)).toEqual({
        size: [SLIDE_WIDTH * 2, SLIDE_HEIGHT * 2],
        colour: [0, 255, 0],
      });
    });

    it('is a PowerPoint file of those pictures, with each slide’s text in its notes', async () => {
      const { mimeType, data } = await exportDeck('Plan & <more>', SLIDES, { format: 'pptx' });
      const files = unzipSync(data);
      const names = Object.keys(files);
      const text = (name: string) => strFromU8(files[name] as Uint8Array);

      expect(mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      );
      expect(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(3);
      // The page has the slide's shape, so the picture fills it without being stretched.
      const [, width, height] = text('ppt/presentation.xml').match(
        /<p:sldSz cx="(\d+)" cy="(\d+)"/,
      ) as RegExpMatchArray;
      expect(Number(width) / Number(height)).toBeCloseTo(SLIDE_WIDTH / SLIDE_HEIGHT, 3);

      const pictures = names.filter((name) => /^ppt\/media\/.+\.png$/.test(name)).sort();
      expect(pictures).toHaveLength(3);
      expect(
        (await Promise.all(pictures.map((name) => seen(Buffer.from(files[name] as Uint8Array)))))
          .map((picture) => picture.colour.join())
          .sort(),
      ).toEqual(['0,0,255', '0,255,0', '255,0,0']);

      // What a slide and a title say is text, never markup of the file's own.
      expect(text('ppt/notesSlides/notesSlide2.xml')).toContain('Q&amp;A &lt;now&gt;');
      expect(text('docProps/core.xml')).toContain('Plan &amp; &lt;more&gt;');
    });

    it('draws in fonts every computer has only when asked to', async () => {
      // The slide says which font it was given, in the one way a picture can show it.
      const told = `<!doctype html><html><body style="margin:0;font-family:Georgia,serif"><p>Text</p><script>
        addEventListener('load', () => {
          const basic = getComputedStyle(document.querySelector('p')).fontFamily.startsWith('Arial');
          document.body.style.background = basic ? '#00ff00' : '#ff0000';
        });
      </script></body></html>`;
      const colour = async (fonts?: 'current' | 'basic') =>
        (await seen((await exportDeck('Plan', [told], { format: 'png', fonts })).data)).colour;

      expect(await colour()).toEqual([255, 0, 0]);
      expect(await colour('current')).toEqual([255, 0, 0]);
      expect(await colour('basic')).toEqual([0, 255, 0]);
    });

    it('lets a slide reach nothing, the gateway’s own machine included', async () => {
      const reached: string[] = [];
      const server = createServer((request, response) => {
        reached.push(request.url ?? '');
        response.end('reached');
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const there = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ways = [
        `<img src="${there}/img"><link rel="stylesheet" href="${there}/css"><script src="${there}/js"></script>`,
        `<script>fetch('${there}/fetch').catch(() => {}); navigator.sendBeacon?.('${there}/beacon'); try { new WebSocket('${there.replace('http', 'ws')}/socket'); } catch {}</script>`,
        `<iframe src="${there}/frame"></iframe><form id="f" action="${there}/form" method="post"></form><script>try { document.getElementById('f').submit(); } catch {}</script>`,
        `<meta http-equiv="refresh" content="0;url=${there}/refresh">`,
        `<script>try { window.open('${there}/open'); } catch {} try { top.location = '${there}/top'; } catch {} location.href = '${there}/self';</script>`,
      ].map((way) => `<!doctype html><html><body style="margin:0;background:#ff0000">${way}`);

      try {
        // The deck is still drawn: a slide that tried is a slide like another.
        const { data } = await exportDeck('Plan', [...ways, SLIDES[2] as string], {
          format: 'pptx',
        });
        expect(
          Object.keys(unzipSync(data)).filter((name) => /^ppt\/media\/.+\.png$/.test(name)),
        ).toHaveLength(ways.length + 1);
        expect(reached).toEqual([]);
      } finally {
        await new Promise((done) => server.close(done));
      }
    });

    it('is read by the owner and by a paired phone, one version at a time', async () => {
      const services = await testServices(undefined, undefined, undefined, 'server');
      const app = createApp({
        ...services,
        token,
        logger: false,
        mode: 'server',
        publicUrl: 'https://jian.example.test',
      });
      apps.push(app);
      const owner = await services.profiles.createProfile({
        name: 'Owner',
        instructions: 'Help.',
        model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
      });
      const session = await services.sessions.createSession(owner.id, { channel: 'api' });
      const deck = await services.artifacts.create(owner.id, session.id, {
        title: 'Plan',
        type: 'deck',
        slides: SLIDES,
      });
      const url = `/v1/profiles/${owner.id}/sessions/${session.id}/artifacts/${deck.id}/versions/1/export`;
      const pairing = await app.inject({ method: 'POST', url: '/v1/devices/pairings', headers });
      const phone = (
        await app.inject({
          method: 'POST',
          url: '/v1/devices/pair',
          payload: { code: pairing.json().code, name: 'Pixel', platform: 'android' },
        })
      ).json() as { token: string };

      for (const authorization of [headers.authorization, `Bearer ${phone.token}`]) {
        const answer = await app.inject({
          url: `${url}?format=png&slide=3`,
          headers: { authorization },
        });
        expect(answer.statusCode).toBe(200);
        const file = deckExportSchema.parse(answer.json());
        expect(file.mimeType).toBe('image/png');
        // The slide asked for, and no other.
        expect((await seen(Buffer.from(file.data, 'base64'))).colour).toEqual([0, 0, 255]);
      }
    });
  },
);
