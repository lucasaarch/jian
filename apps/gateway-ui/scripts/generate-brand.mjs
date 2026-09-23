import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const web = `${root}/apps/gateway-ui/public/brand`;
const wing = 'M8 9 53 27 72 49 58 62 33 51 18 34 48 48 12 22 54 40Z';
const body = 'm42 95 7-28 10-12 13-18 12-4 14 8-14 4-9 19-14 12Z';
const bird = `<path d="${wing}"/><path d="${body}"/>`;
const svg = (content, width, height = width) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`;

await mkdir(web, { recursive: true });
await writeFile(
  `${web}/jian.svg`,
  svg(`<title>Jian — the one-winged bird</title><g fill="#b51e49">${bird}</g>`, 104),
);
await writeFile(
  `${web}/jian-mono.svg`,
  svg(`<title>Jian — monochrome</title><g fill="currentColor">${bird}</g>`, 104),
);

// Embed the font so README renderers do not depend on the viewer's installed typefaces.
const font = await readFile(
  new URL(
    '../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff2',
    import.meta.url,
  ),
);
const banner = svg(
  `<title>Jian — Só voa quando se conecta.</title>
<defs><style>@font-face{font-family:Barlow;src:url(data:font/woff2;base64,${font.toString('base64')})}text{font-family:Barlow,'Arial Narrow',sans-serif}</style></defs>
<rect width="1440" height="480" fill="#fff"/>
<g stroke="#e0e3e8" fill="none"><path d="M48 48h1344v384H48Z"/><path d="m1120 46 166 96v194l-166 96-166-96V142Z"/><path d="m1120 78 139 80v162l-139 80-139-80V158Z" stroke-dasharray="3 8"/><path d="M900 240h74m292 0h126"/></g>
<path d="M48 116V48h68M1324 432h68v-68" stroke="#b51e49" stroke-width="3" fill="none"/>
<g transform="translate(83 81) scale(.62)" fill="#b51e49">${bird}</g>
<text x="170" y="146" font-size="82" font-weight="600" fill="#20252d">jian</text>
<text x="94" y="274" font-size="78" font-weight="600" fill="#20252d">Só voa quando se conecta.</text>
<text x="97" y="330" font-family="sans-serif" font-size="23" fill="#59616d">Agentes com identidade. Conexões com propósito.</text>
<g transform="translate(997 114) scale(2.35)" fill="#b51e49">${bird}</g>
<text x="97" y="402" font-size="19" fill="#59616d">Self-hosted agent gateway</text>`,
  1440,
  480,
);
await writeFile(`${web}/readme-banner.svg`, banner);
// Raster copy is portable across Markdown viewers that restrict SVG embedded fonts.
await sharp(Buffer.from(banner)).png().toFile(`${web}/readme-banner.png`);

// A phone keeps the panel on its home screen with this, drawn edge to edge as iOS expects.
const touchIcon = svg(
  `<rect width="1024" height="1024" fill="#fff"/><g transform="translate(154 154) scale(6.9)" fill="#b51e49">${bird}</g>`,
  1024,
);
await sharp(Buffer.from(touchIcon)).resize(180).png().toFile(`${web}/apple-touch-icon.png`);
console.log('Jian: SVG logos, README banner and touch icon generated.');
