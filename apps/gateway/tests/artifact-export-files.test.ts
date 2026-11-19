import { existsSync } from 'node:fs';
import { deckExportSchema } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { documentDocx } from '../src/artifacts/document-export.js';
import { exportDocumentPdf } from '../src/artifacts/export.js';
import { sheetCsv, sheetXlsx } from '../src/artifacts/sheet-export.js';
import { testServices } from './helpers/services.js';

// As artifact-export.test.ts: only the browser's launch is replaced, to start it plainly.
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
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const png = await sharp({
  create: { width: 40, height: 20, channels: 3, background: '#2255cc' },
})
  .png()
  .toBuffer();

/** Every element a Document can say, and a few that are only text to a file. */
const DOCUMENT = `# Quarterly plan

Plain text with **bold**, *italic*, ~~struck~~, \`inline code\` and a [link](https://example.test/path?a=1&b=2). Fish & a < b.

## Steps

- first
- second
  - nested bullet
    - deeper bullet
- [x] done task
- [ ] open task

1. one
2. two
   1. two-a

3. start again

> quoted *words*

\`\`\`ts
const answer = 42;
  indented();
\`\`\`

| Name | Qty |
|:-----|----:|
| Pens | **12** |
| Ink  | 3 |

---

![tiny](data:image/png;base64,${png.toString('base64')})

![far](https://example.test/far.png)

<div>Raw <b>html</b> text</div>
`;

const body = (docx: Buffer) => strFromU8(unzipSync(docx)['word/document.xml'] as Uint8Array);

describe('a Document as a Word file', () => {
  it('keeps every element as Word’s own, editable', async () => {
    const files = unzipSync(await documentDocx('Plan & <more>', DOCUMENT));
    const xml = body(Buffer.from(await documentDocx('Plan', DOCUMENT)));

    expect(files['[Content_Types].xml']).toBeDefined();
    for (const level of [1, 2]) expect(xml).toContain(`w:val="Heading${level}"`);
    expect(xml).toContain('Quarterly plan');
    expect(xml).toMatch(/<w:b\/>[\s\S]*?bold/);
    expect(xml).toMatch(/<w:i\/>[\s\S]*?italic/);
    expect(xml).toContain('<w:strike/>');
    // Inline code is a font of its own; a block of it is a paragraph a line, spaces kept.
    expect(xml).toContain('Courier New');
    expect(xml).toContain('const answer = 42;');
    expect(xml).toMatch(/xml:space="preserve">\s*indented\(\);/);
    // A link is a relationship, with its address unescaped once and escaped in the XML.
    expect(strFromU8(files['word/_rels/document.xml.rels'] as Uint8Array)).toContain(
      'https://example.test/path?a=1&amp;b=2',
    );
    // Text is text: entities are read once, and written as XML.
    expect(xml).toContain('Fish &amp; a &lt; b.');
    expect(xml).not.toContain('&amp;amp;');
    // Lists are numbered by Word, nested ones a level in; tasks carry their box.
    expect(xml).toContain('<w:numPr>');
    expect(xml).toMatch(/<w:ilvl w:val="2"\/>/);
    expect(xml).toContain('☑ ');
    expect(xml).toContain('☐ ');
    expect(strFromU8(files['word/numbering.xml'] as Uint8Array)).toMatch(
      /w:numFmt w:val="decimal"/,
    );
    // A quote's rule, a table with its header and alignment, a rule, a picture.
    expect(xml).toMatch(/<w:pBdr><w:left /);
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('<w:tblHeader/>');
    expect(xml).toMatch(/<w:jc w:val="right"\/>/);
    expect(xml).toMatch(/<w:pBdr><w:bottom /);
    expect(Object.keys(files).filter((name) => /^word\/media\/.+\.png$/.test(name))).toHaveLength(
      1,
    );
    // A picture the file cannot hold stays as a link; raw HTML as its text.
    expect(xml).toContain('far');
    expect(xml).toContain('Raw html text');
    expect(strFromU8(files['docProps/core.xml'] as Uint8Array)).toContain(
      'Plan &amp; &lt;more&gt;',
    );
  });

  it('numbers a list from where it starts', async () => {
    const files = unzipSync(await documentDocx('Plan', '3. three\n4. four\n'));

    expect(strFromU8(files['word/numbering.xml'] as Uint8Array)).toMatch(/<w:start w:val="3"\/>/);
  });

  it('is made from nothing at all', async () => {
    expect(body(await documentDocx('Empty', ''))).toContain('<w:body>');
  });
});

describe('a spreadsheet as an Excel file', () => {
  it('keeps a formula and the value the panel shows for it', async () => {
    const xlsx = await sheetXlsx(
      'Budget: [2026]',
      'Item,Cost\nPens,2.5\nInk,"3,5"\nTotal,=SUM(B2:B3)\nHalf,=B4/2\nBroken,=1/0\nLabel,="n=" & B2\n',
    );
    const files = unzipSync(xlsx);
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'] as Uint8Array);

    expect(strFromU8(files['xl/workbook.xml'] as Uint8Array)).toContain('Budget   2026');
    // The sum of a number and a text that is no number: the panel counts only the number.
    expect(sheet).toMatch(/<f>SUM\(B2:B3\)<\/f><v>2\.5<\/v>/);
    expect(sheet).toMatch(/<f>B4\/2<\/f><v>1\.25<\/v>/);
    expect(sheet).toMatch(/<c r="B6"[^>]*t="e"[^>]*><f>1\/0<\/f><v>#DIV\/0!<\/v>/);
    expect(sheet).toContain('<f>&quot;n=&quot; &amp; B2</f>');
    // Plain cells are numbers where they read as one.
    expect(sheet).toMatch(/<c r="B2"[^>]*><v>2\.5<\/v>/);
  });

  it('writes the values of a CSV, not its formulas', () => {
    expect(sheetCsv('Item,Cost\nPens,2.5\nTotal,=SUM(B2:B2)*2\nBad,=1/0\nNote,"a, b"\n')).toBe(
      'Item,Cost\nPens,2.5\nTotal,5\nBad,#DIV/0!\nNote,"a, b"\n',
    );
  });
});

describe.runIf(existsSync(process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? chromium.executablePath()))(
  'a Document as a PDF',
  { timeout: 60_000 },
  () => {
    it('is A4 pages that break between lines, never through them', async () => {
      const long = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of a long page.`).join(
        '\n\n',
      );
      const { mimeType, data } = await exportDocumentPdf('Plan', `${DOCUMENT}\n\n${long}`);
      const pdf = data.toString('latin1');

      expect(mimeType).toBe('application/pdf');
      expect(pdf.startsWith('%PDF-')).toBe(true);
      expect(pdf.match(/\/Type\s*\/Page\b/g)?.length).toBeGreaterThan(1);
      // A4 in points, to the rounding of the browser.
      expect(pdf).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+595\.\d+\s+84[23]\.\d+\s*\]/);
    });

    it('is as sealed as a page: what the document says cannot reach the network', async () => {
      // Offline and refused before it leaves: a document that tries still has its file.
      const { data } = await exportDocumentPdf(
        'Plan',
        '# Hi\n\n<img src="http://127.0.0.1:9/x" onerror="fetch(\'http://127.0.0.1:9/y\')">\n',
      );

      expect(data.subarray(0, 5).toString()).toBe('%PDF-');
    });
  },
);

describe('the export route', () => {
  async function setup() {
    const services = await testServices(undefined, undefined, undefined, 'server');
    const app = createApp({
      ...services,
      token,
      logger: false,
      mode: 'server',
      publicUrl: 'https://jian.example.test',
    });
    apps.push(app);
    const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;
    const owner = await services.profiles.createProfile({
      name: 'Owner',
      instructions: 'x',
      model,
    });
    const other = await services.profiles.createProfile({
      name: 'Other',
      instructions: 'x',
      model,
    });
    const session = await services.sessions.createSession(owner.id, { channel: 'api' });
    const make = (type: 'markdown' | 'sheet' | 'html', content: string) =>
      services.artifacts.create(owner.id, session.id, { title: 'Plan', type, content });
    const url = (artifactId: string, profileId = owner.id) =>
      `/v1/profiles/${profileId}/sessions/${session.id}/artifacts/${artifactId}/versions/1/export`;

    return { app, owner, other, make, url };
  }

  it('answers a Word file for a Document and an Excel file for a sheet', async () => {
    const { app, make, url } = await setup();
    const document = await make('markdown', '# Hi\n\nA *Word*.');
    const sheet = await make('sheet', 'a,b\n1,=A2+1\n');

    const word = await app.inject({ url: `${url(document.id)}?format=docx`, headers });
    expect(word.statusCode).toBe(200);
    const file = deckExportSchema.parse(word.json());
    expect(file.mimeType).toContain('wordprocessingml');
    expect(body(Buffer.from(file.data, 'base64'))).toContain('Hi');

    const excel = await app.inject({ url: `${url(sheet.id)}?format=xlsx`, headers });
    expect(excel.statusCode).toBe(200);
    expect(deckExportSchema.parse(excel.json()).mimeType).toContain('spreadsheetml');

    const csv = await app.inject({ url: `${url(sheet.id)}?format=csv`, headers });
    expect(csv.statusCode).toBe(200);
    expect(Buffer.from(deckExportSchema.parse(csv.json()).data, 'base64').toString('utf8')).toBe(
      'a,b\n1,2\n',
    );
  });

  it('refuses another profile’s Artifact, and a format its type has not', async () => {
    const { app, other, make, url } = await setup();
    const document = await make('markdown', '# Secret');
    const sheet = await make('sheet', 'a\n1\n');
    const page = await make('html', '<p>x</p>');

    const foreign = await app.inject({
      url: `${url(document.id, other.id)}?format=docx`,
      headers,
    });
    expect(foreign.statusCode).toBeGreaterThanOrEqual(400);
    expect(foreign.body).not.toContain('Secret');
    // No credential, no file.
    expect((await app.inject({ url: `${url(document.id)}?format=docx` })).statusCode).toBe(401);

    for (const [id, format] of [
      [document.id, 'xlsx'],
      [document.id, 'csv'],
      [document.id, 'pptx'],
      [sheet.id, 'docx'],
      [sheet.id, 'pdf'],
      [page.id, 'docx'],
    ] as const) {
      const answer = await app.inject({ url: `${url(id)}?format=${format}`, headers });
      expect(answer.statusCode).toBe(400);
    }
  });

  it('says a PDF of a Document needs a server gateway, and still makes a Word file', async () => {
    const services = await testServices(undefined, undefined, undefined, 'local');
    const app = createApp({ ...services, token, logger: false, mode: 'local' });
    apps.push(app);
    const owner = await services.profiles.createProfile({
      name: 'Owner',
      instructions: 'x',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const session = await services.sessions.createSession(owner.id, { channel: 'api' });
    const document = await services.artifacts.create(owner.id, session.id, {
      title: 'Plan',
      type: 'markdown',
      content: '# Hi',
    });
    const url = `/v1/profiles/${owner.id}/sessions/${session.id}/artifacts/${document.id}/versions/1/export`;

    expect((await app.inject({ url: `${url}?format=pdf`, headers })).statusCode).toBe(409);
    expect((await app.inject({ url: `${url}?format=docx`, headers })).statusCode).toBe(200);
  });
});
