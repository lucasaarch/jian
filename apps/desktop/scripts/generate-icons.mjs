import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

/**
 * The app's icons from the same bird the web panel draws (apps/web/scripts/generate-brand.mjs):
 * build/icon.png, from which electron-builder makes .icns and .ico, and the tray icons. Run again
 * only when the mark changes; the PNGs are committed.
 */
const wing =
  'M8 68C28 64 45 51 60 27c2 14-2 27-11 37 13-5 26-16 37-33-2 25-15 42-38 50-16 5-30 1-40-13Z';
const body = 'M54 71c11-2 21-8 29-17l10-1-9 7c-7 14-21 24-41 25-8 0-16-2-22-5 13 1 24-2 33-9Z';
const bird = (fill) => `<g fill="${fill}"><path d="${wing}"/><path d="${body}"/></g>`;
/** The bird scaled by `scale` and centred in the 96 box: its paths span x 8–93 and y 27–96. */
const centred = (scale, fill) =>
  `<g transform="translate(${48 - scale * 50.5} ${48 - scale * 61.5}) scale(${scale})">${bird(fill)}</g>`;
const svg = (content) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">${content}</svg>`,
  );

const root = new URL('../', import.meta.url).pathname;
await mkdir(`${root}build`, { recursive: true });
await mkdir(`${root}resources`, { recursive: true });

// macOS draws app icons on a rounded square with a margin; the mark sits inside it.
const app = svg(
  `<rect x="9" y="9" width="78" height="78" rx="18" fill="#050505"/>${centred(0.62, '#f5f5f3')}`,
);
await sharp(app, { density: 1024 }).resize(1024, 1024).png().toFile(`${root}build/icon.png`);
// Windows and Linux windows show their icon at runtime; macOS reads the bundle's .icns instead.
await sharp(app, { density: 512 }).resize(512, 512).png().toFile(`${root}resources/icon.png`);

// The menu bar tints a template image itself: black with alpha, 16 pt and its @2x.
const template = svg(centred(1.05, '#000000'));
await sharp(template, { density: 256 })
  .resize(16, 16)
  .png()
  .toFile(`${root}resources/trayTemplate.png`);
await sharp(template, { density: 512 })
  .resize(32, 32)
  .png()
  .toFile(`${root}resources/trayTemplate@2x.png`);

// Windows and Linux trays are dark or light by theme; the mark on its own dark tile reads on both.
const tray = svg(`<rect width="96" height="96" rx="20" fill="#050505"/>${centred(0.8, '#f5f5f3')}`);
await sharp(tray, { density: 512 }).resize(32, 32).png().toFile(`${root}resources/tray.png`);
