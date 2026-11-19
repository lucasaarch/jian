import { type DeckExportQuery, SLIDE_HEIGHT, SLIDE_WIDTH } from '@jian/contracts';
import type { Page } from 'playwright';
import { GatewayError } from '../core/errors.js';
import { launchChromium } from '../web/browser.js';
import { artifactPage, artifactPolicy, escaped } from './document.js';

/**
 * A deck as a file to keep: its slides drawn by the gateway's own browser, since a picture of a
 * slide is only made by something that draws it, and the panel can never look inside the sealed
 * frame it shows one in.
 *
 * What an agent wrote runs here too, so the page is as sealed as the frame the owner reads it in
 * (document.ts), and then some:
 *
 * - The slides stand each in a sandboxed `srcdoc` frame of one sheet, which is answered with the
 *   Artifact's own policy: nothing is fetched or connected to, and `frame-src 'none'` refuses a
 *   slide that would take itself elsewhere.
 * - The browser is offline and has one address it may ask for, once: the sheet, which is answered
 *   from memory. Every other request is refused before it leaves, the gateway's own address
 *   included, so a hole in the policy still reaches nothing.
 * - It is a browser started for this export and closed after it, with no cookie, no credential
 *   and none of the gateway's environment (web/browser.ts).
 */

/** Never resolves: `.invalid` is kept for names that must not (RFC 2606). */
const SHEET = 'https://deck.invalid/';

/** Device pixels per CSS pixel of a picture: twice the canvas reads sharp on a large screen. */
const SCALE = 2;

/** A deck that is not drawn by then is given up on, and its browser closed. */
const DEADLINE_MS = 90_000;
const LOAD_MS = 30_000;

/** The most a PowerPoint file's pictures weigh together; the answer holds them all in memory. */
const PICTURES_MAX_BYTES = 64 * 1024 * 1024;
const NOTES_MAX = 10_000;

/** A PowerPoint page's width in inches, as its widescreen layout has it. */
const PAGE_INCHES = 13.333;

/**
 * A file is the slide as it rests, so nothing is caught halfway in: an animation is at its end
 * and a transition has happened.
 */
const STILL =
  '*, *::before, *::after { animation-delay: 0s !important; animation-duration: 0s !important; transition: none !important; }';

/**
 * Fonts every computer has, over whatever the slide asked for. Code keeps a width of its own.
 * The gateway's image carries fonts with the same measures as these (Dockerfile).
 */
const BASIC = `*, *::before, *::after { font-family: Arial, Helvetica, "Liberation Sans", sans-serif !important; }
code, pre, kbd, samp, code *, pre * { font-family: "Courier New", Courier, "Liberation Mono", monospace !important; }`;

export const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

/**
 * Every slide in a frame of its own, one under the other, each a page when printed. The sheet a
 * slide is drawn on is white, as it is wherever a slide is shown.
 */
function sheet(slides: readonly string[], basic: boolean): string {
  // After the slide's own markup, so it is the last word on what it overrides.
  const style = `<style>${STILL}${basic ? BASIC : ''}</style>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
@page { size: ${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px; margin: 0; }
html, body { margin: 0; background: #fff; }
iframe { display: block; width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px; border: 0; break-after: page; }
iframe:last-child { break-after: auto; }
</style>
</head>
<body>${slides
    .map(
      (slide) =>
        `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escaped(slide + style)}"></iframe>`,
    )
    .join('')}</body>
</html>
`;
}

/** The slides on a page of the browser, drawn and at rest, for `read` to take what it wants. */
async function drawn<T>(
  slides: readonly string[],
  basic: boolean,
  read: (page: Page) => Promise<T>,
): Promise<T> {
  const browser = await launchChromium();
  // Closing the browser fails whatever is waiting on it, which is how a deck that never
  // finishes drawing, as one with a script that never ends, is given up on.
  const deadline = setTimeout(() => void browser.close().catch(() => {}), DEADLINE_MS);

  try {
    const context = await browser.newContext({
      viewport: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT },
      deviceScaleFactor: SCALE,
      serviceWorkers: 'block',
      acceptDownloads: false,
      offline: true,
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    let served = false;
    await context.route('**/*', (route) => {
      if (served || route.request().url() !== SHEET) return route.abort();
      served = true;
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: { 'content-security-policy': artifactPolicy("'none'") },
        body: sheet(slides, basic),
      });
    });
    const page = await context.newPage();
    // Printed, a slide is still the slide on the screen, not its print style.
    await page.emulateMedia({ media: 'screen' });
    await page.goto(SHEET, { waitUntil: 'load', timeout: LOAD_MS });
    // A font written into a slide is read after the slide has loaded, and a script may draw on
    // the frame after that one. A frame that went nowhere has nothing to wait for.
    await Promise.all(
      page
        .frames()
        .map((frame) =>
          frame
            .evaluate(() =>
              document.fonts.ready.then(() => new Promise((done) => setTimeout(done, 150))),
            )
            .catch(() => {}),
        ),
    );

    return await read(page);
  } finally {
    clearTimeout(deadline);
    await browser.close().catch(() => {});
  }
}

/** Each slide as a picture, with the text it shows. */
async function pictures(page: Page, count: number): Promise<{ png: Buffer; text: string }[]> {
  const taken: { png: Buffer; text: string }[] = [];
  let bytes = 0;

  for (let index = 0; index < count; index += 1) {
    const frame = page.locator('iframe').nth(index);
    const png = await frame.screenshot({ type: 'png' });
    bytes += png.length;
    if (bytes > PICTURES_MAX_BYTES) {
      throw new GatewayError(
        413,
        'These slides are too heavy for one PowerPoint file. Download the deck as a PDF instead.',
      );
    }
    const inside = await (await frame.elementHandle())?.contentFrame();
    const text = await inside?.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    taken.push({ png, text: text ?? '' });
  }

  return taken;
}

/**
 * A PowerPoint file of pictures: each slide fills its page as it was drawn, so it looks the same
 * on any computer, and its text goes in the notes, where it can be searched and copied. The
 * slide is not rebuilt out of PowerPoint's own shapes: a page written in HTML has no faithful
 * translation into them.
 */
async function powerpoint(title: string, slides: { png: Buffer; text: string }[]): Promise<Buffer> {
  // Loaded only here: nothing else of the gateway writes Office files. Its types read as a
  // CommonJS module that holds the class under `default`; what Node loads is the class itself.
  const loaded = (await import('pptxgenjs')).default;
  const Pptx = loaded as unknown as typeof loaded.default;
  const deck = new Pptx();

  deck.defineLayout({
    name: 'DECK',
    width: PAGE_INCHES,
    height: (PAGE_INCHES * SLIDE_HEIGHT) / SLIDE_WIDTH,
  });
  deck.layout = 'DECK';
  deck.title = title;
  for (const [index, { png, text }] of slides.entries()) {
    const slide = deck.addSlide();
    slide.addImage({
      data: `image/png;base64,${png.toString('base64')}`,
      x: 0,
      y: 0,
      w: '100%',
      h: '100%',
      altText: `Slide ${index + 1}`,
    });
    // What XML cannot hold would make a file PowerPoint refuses to open.
    const notes = text
      .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
      .trim()
      .slice(0, NOTES_MAX);
    if (notes) slide.addNotes(notes);
  }

  return Buffer.from((await deck.write({ outputType: 'nodebuffer' })) as Uint8Array);
}

// One deck at a time: a browser at twice a slide's size is the heaviest thing the gateway runs.
let line: Promise<unknown> = Promise.resolve();

/**
 * The file for these slides: all of them as a PDF or a PowerPoint file, or the one given as a
 * picture. It says in words why it could not be made, for the panel to tell the owner.
 */
export function exportDeck(
  title: string,
  slides: readonly string[],
  wanted: { format: 'pdf' | 'png' | 'pptx'; fonts?: DeckExportQuery['fonts'] },
): Promise<{ mimeType: string; data: Buffer }> {
  const made = line.then(async () => {
    try {
      const data = await drawn(slides, wanted.fonts === 'basic', async (page) => {
        if (wanted.format === 'pdf') {
          return page.pdf({
            width: `${SLIDE_WIDTH}px`,
            height: `${SLIDE_HEIGHT}px`,
            printBackground: true,
            preferCSSPageSize: true,
          });
        }
        const taken = await pictures(page, slides.length);
        if (wanted.format === 'pptx') return powerpoint(title, taken);
        return (taken[0] as { png: Buffer }).png;
      });

      return { mimeType: MIME[wanted.format], data };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(
        503,
        `The deck could not be drawn for this file: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`,
      );
    }
  });

  line = made.catch(() => {});
  return made;
}

/** Where the Document's page is served from, once. Never resolves, as the deck's sheet. */
const DOCUMENT = 'https://document.invalid/';

/**
 * What a printed page changes of the panel's own document: a line is not cut by a page, a heading
 * stays with what follows it, and a long line of code wraps, since paper has no scrollbar. The
 * look itself is the frame's.
 */
const PRINT = `<style>
pre { overflow: visible; white-space: pre-wrap; }
pre, blockquote, table, img, svg, tr, li { break-inside: avoid; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; }
</style>`;

/**
 * A Document as a PDF: the page the panel draws it in (document.ts), in its light theme, on A4
 * with margins. What an agent wrote runs here too, so the browser is as shut as a deck's: offline,
 * one address answered from memory under the Artifact's own policy, closed after the file.
 */
export function exportDocumentPdf(
  title: string,
  source: string,
): Promise<{ mimeType: string; data: Buffer }> {
  const made = line.then(async () => {
    const browser = await launchChromium();
    const deadline = setTimeout(() => void browser.close().catch(() => {}), DEADLINE_MS);

    try {
      const context = await browser.newContext({
        colorScheme: 'light',
        serviceWorkers: 'block',
        acceptDownloads: false,
        offline: true,
      });
      await context.routeWebSocket('**/*', (socket) => socket.close());
      let served = false;
      await context.route('**/*', (route) => {
        if (served || route.request().url() !== DOCUMENT) return route.abort();
        served = true;
        return route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: { 'content-security-policy': artifactPolicy("'none'") },
          body: artifactPage('markdown', { title, source }).replace('</head>', `${PRINT}</head>`),
        });
      });
      const page = await context.newPage();
      await page.emulateMedia({ media: 'screen', colorScheme: 'light' });
      await page.goto(DOCUMENT, { waitUntil: 'load', timeout: LOAD_MS });
      // Pictures written into the document and fonts are drawn before the page is printed.
      await page.evaluate(() =>
        Promise.all([
          document.fonts.ready,
          ...[...document.images].map((image) => image.decode().catch(() => {})),
        ]),
      );
      const data = await page.pdf({
        format: 'A4',
        margin: { top: '20mm', right: '18mm', bottom: '20mm', left: '18mm' },
        printBackground: true,
      });

      return { mimeType: MIME.pdf, data };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(
        503,
        `The document could not be drawn for this file: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`,
      );
    } finally {
      clearTimeout(deadline);
      await browser.close().catch(() => {});
    }
  });

  line = made.catch(() => {});
  return made;
}
