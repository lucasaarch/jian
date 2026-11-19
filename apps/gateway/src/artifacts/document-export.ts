import { marked, type Token, type Tokens } from 'marked';
import sharp from 'sharp';

/**
 * A Document (Markdown) as a Word file, built from the same parser the panel draws it with
 * (marked), so what is a heading, a list or a table here is what the panel says it is. The file
 * is made of Word's own paragraphs, lists and tables, never of a picture: it opens and edits in
 * Word, Google Docs and LibreOffice. It needs no browser, so every gateway makes one.
 *
 * What a file cannot hold stays out rather than breaking it. A picture is embedded only when it
 * is written into the document (a `data:` address): the gateway never fetches an address an
 * agent wrote, so any other picture is kept as a link to it. Raw HTML is read as its text.
 */

/** A4 in twips (a twentieth of a point) with one-inch margins: what a table's columns divide. */
const TEXT_WIDTH = 11906 - 2 * 1440;
const INDENT = 360;
const MONO = 'Courier New';
const IMAGE_MAX_WIDTH_PX = 600;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' } as const;

type Docx = typeof import('docx');
type Child = InstanceType<Docx['TextRun']> | InstanceType<Docx['ExternalHyperlink']>;
type Block = InstanceType<Docx['Paragraph']> | InstanceType<Docx['Table']>;
type Marks = { bold?: boolean; italics?: boolean; strike?: boolean };
/** Where a block stands: how far in, and whether inside a quote. */
type Place = { indent: number; quote: boolean };

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};
// marked leaves what it escaped in the text it hands over.
const unescaped = (text: string) =>
  text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);

/** What XML cannot hold would make a file Word refuses to open. */
const clean = (text: string) =>
  text.replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '');

/** A picture written into the document: its bytes and kind, or nothing. */
function embedded(href: string): { data: Buffer; type: 'png' | 'jpg' | 'gif' } | undefined {
  const found = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(href);
  const type = found ? IMAGE_TYPES[found[1]?.toLowerCase() as keyof typeof IMAGE_TYPES] : undefined;

  return found && type ? { data: Buffer.from(found[2] ?? '', 'base64'), type } : undefined;
}

export async function documentDocx(title: string, source: string): Promise<Buffer> {
  // Loaded only here: nothing else of the gateway writes Word files.
  const d: Docx = await import('docx');
  const orderedLists: { reference: string; start: number; depth: number }[] = [];

  const run = (text: string, marks: Marks, extra: object = {}) =>
    new d.TextRun({
      text: clean(text),
      bold: marks.bold,
      italics: marks.italics,
      strike: marks.strike,
      ...extra,
    });

  async function inline(tokens: Token[] | undefined, marks: Marks = {}): Promise<Child[]> {
    const made: Child[] = [];

    for (const token of tokens ?? []) {
      switch (token.type) {
        case 'text':
        case 'escape': {
          const inner = (token as Tokens.Text).tokens;
          if (inner?.length) made.push(...(await inline(inner, marks)));
          else made.push(run(unescaped(token.text), marks));
          break;
        }
        case 'strong':
          made.push(...(await inline((token as Tokens.Strong).tokens, { ...marks, bold: true })));
          break;
        case 'em':
          made.push(...(await inline((token as Tokens.Em).tokens, { ...marks, italics: true })));
          break;
        case 'del':
          made.push(...(await inline((token as Tokens.Del).tokens, { ...marks, strike: true })));
          break;
        case 'codespan':
          made.push(
            run((token as Tokens.Codespan).text, marks, {
              font: MONO,
              shading: { type: d.ShadingType.CLEAR, fill: 'EEEEEE' },
            }),
          );
          break;
        case 'br':
          made.push(new d.TextRun({ break: 1 }));
          break;
        case 'link': {
          const link = token as Tokens.Link;
          const text = await inline(link.tokens, { ...marks });
          made.push(
            new d.ExternalHyperlink({
              link: link.href,
              children: text.length
                ? (text as InstanceType<Docx['TextRun']>[])
                : [run(link.href, marks)],
            }),
          );
          break;
        }
        case 'image': {
          const image = token as Tokens.Image;
          const own = embedded(image.href);
          const size = own
            ? await sharp(own.data)
                .metadata()
                .catch(() => undefined)
            : undefined;
          if (own && size?.width && size.height) {
            const width = Math.min(size.width, IMAGE_MAX_WIDTH_PX);
            made.push(
              new d.ImageRun({
                type: own.type,
                data: own.data,
                transformation: { width, height: Math.round((size.height * width) / size.width) },
                altText: {
                  name: 'Image',
                  title: image.title ?? image.text,
                  description: image.text,
                },
              }) as unknown as Child,
            );
          } else {
            // Out of reach for a file: the alt text, linked to where it was.
            made.push(
              new d.ExternalHyperlink({
                link: image.href,
                children: [run(image.text || image.href, marks)],
              }),
            );
          }
          break;
        }
        case 'html': {
          const tag = (token as Tokens.HTML).text.trim();
          if (/^<br\s*\/?>$/i.test(tag)) made.push(new d.TextRun({ break: 1 }));
          break;
        }
        default:
          if ('text' in token && typeof token.text === 'string') {
            made.push(run(unescaped(token.text), marks));
          }
      }
    }

    return made;
  }

  const spacing = { after: 120 };
  const quoted = (place: Place) =>
    place.quote
      ? {
          border: {
            left: { style: d.BorderStyle.SINGLE, size: 18, space: 8, color: 'BBBBBB' },
          },
        }
      : {};
  const paragraph = (children: Child[], place: Place, extra: object = {}) =>
    new d.Paragraph({
      children,
      spacing,
      indent: { left: place.indent + (place.quote ? INDENT : 0) },
      ...quoted(place),
      ...extra,
    });

  async function list(token: Tokens.List, place: Place, depth: number): Promise<Block[]> {
    const made: Block[] = [];
    let reference = 'bullets';
    if (token.ordered) {
      reference = `ordered-${orderedLists.length}`;
      orderedLists.push({ reference, start: Number(token.start) || 1, depth });
    }

    for (const item of token.items) {
      let first = true;
      for (const child of item.tokens) {
        if (child.type === 'checkbox') continue;
        if (child.type === 'text' || child.type === 'paragraph') {
          const children = await inline((child as Tokens.Text).tokens);
          const mark = first && item.task ? [run(item.checked ? '☑ ' : '☐ ', {})] : [];
          // A task item carries its box in place of a bullet: a bullet and a box would be two.
          const bullet = first && !item.task;
          made.push(
            paragraph([...mark, ...children], place, {
              spacing: { after: 60 },
              // The list's own level sets the indent; one given here would override it.
              ...(bullet
                ? {
                    indent: undefined,
                    numbering: { reference, level: token.ordered ? 0 : Math.min(depth, 8) },
                  }
                : { indent: { left: place.indent + (depth + 1) * INDENT * 2 } }),
            }),
          );
          first = false;
        } else if (child.type === 'list') {
          made.push(...(await list(child as Tokens.List, place, depth + 1)));
        } else {
          made.push(
            ...(await blocks([child], {
              ...place,
              indent: place.indent + (depth + 1) * INDENT * 2,
            })),
          );
        }
      }
    }

    return made;
  }

  const cell = async (token: Tokens.TableCell, header: boolean, width: number) =>
    new d.TableCell({
      width: { size: width, type: d.WidthType.DXA },
      shading: header ? { type: d.ShadingType.CLEAR, fill: 'F0F0F0' } : undefined,
      children: [
        new d.Paragraph({
          children: await inline(token.tokens, header ? { bold: true } : {}),
          alignment:
            token.align === 'center'
              ? d.AlignmentType.CENTER
              : token.align === 'right'
                ? d.AlignmentType.RIGHT
                : d.AlignmentType.LEFT,
        }),
      ],
    });

  async function table(token: Tokens.Table): Promise<Block> {
    const width = Math.floor(TEXT_WIDTH / Math.max(1, token.header.length));
    const row = async (cells: Tokens.TableCell[], header: boolean) =>
      new d.TableRow({
        tableHeader: header,
        cantSplit: true,
        children: await Promise.all(cells.map((one) => cell(one, header, width))),
      });

    return new d.Table({
      width: { size: width * token.header.length, type: d.WidthType.DXA },
      columnWidths: token.header.map(() => width),
      rows: [
        await row(token.header, true),
        ...(await Promise.all(token.rows.map((cells) => row(cells, false)))),
      ],
    });
  }

  async function blocks(tokens: Token[], place: Place): Promise<Block[]> {
    const made: Block[] = [];

    for (const token of tokens) {
      switch (token.type) {
        case 'heading': {
          const heading = token as Tokens.Heading;
          made.push(
            paragraph(await inline(heading.tokens), place, {
              heading: [
                d.HeadingLevel.HEADING_1,
                d.HeadingLevel.HEADING_2,
                d.HeadingLevel.HEADING_3,
                d.HeadingLevel.HEADING_4,
                d.HeadingLevel.HEADING_5,
                d.HeadingLevel.HEADING_6,
              ][Math.min(heading.depth, 6) - 1],
              spacing: { before: 240, after: 120 },
            }),
          );
          break;
        }
        case 'paragraph':
        case 'text':
          made.push(paragraph(await inline((token as Tokens.Paragraph).tokens), place));
          break;
        case 'code': {
          // A paragraph a line, none apart from the next, so the block reads as one in Word.
          const lines = (token as Tokens.Code).text.split('\n');
          for (const [index, line] of lines.entries()) {
            made.push(
              paragraph([run(line, {}, { font: MONO, size: 20 })], place, {
                spacing: { after: index === lines.length - 1 ? 160 : 0 },
                shading: { type: d.ShadingType.CLEAR, fill: 'F3F3F3' },
              }),
            );
          }
          break;
        }
        case 'blockquote':
          made.push(
            ...(await blocks((token as Tokens.Blockquote).tokens, { ...place, quote: true })),
          );
          break;
        case 'list':
          made.push(...(await list(token as Tokens.List, place, 0)));
          break;
        case 'table':
          made.push(await table(token as Tokens.Table));
          break;
        case 'hr':
          made.push(
            paragraph([], place, {
              border: {
                bottom: { style: d.BorderStyle.SINGLE, size: 6, space: 1, color: '999999' },
              },
            }),
          );
          break;
        case 'html': {
          // Read as the text it holds, a tag at a time out of it.
          const text = unescaped((token as Tokens.HTML).text.replace(/<[^>]*>/g, '')).trim();
          if (text) made.push(paragraph([run(text, {})], place));
          break;
        }
        default:
          // `space` and `def` draw nothing.
          break;
      }
    }

    return made;
  }

  const children = await blocks(marked.lexer(source), { indent: 0, quote: false });
  const size = (points: number) => points * 2;
  const heading = (id: string, points: number) => ({
    id,
    name: id.replace('Heading', 'heading '),
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: true,
    run: { size: size(points), bold: true, color: '000000' },
  });
  const bulletMarks = ['•', '◦', '▪'];

  const file = new d.Document({
    title: clean(title),
    creator: 'Jian',
    styles: {
      default: { document: { run: { font: 'Calibri', size: size(11) } } },
      paragraphStyles: [
        heading('Heading1', 20),
        heading('Heading2', 16),
        heading('Heading3', 14),
        heading('Heading4', 12),
        heading('Heading5', 11),
        heading('Heading6', 11),
      ],
    },
    numbering: {
      config: [
        {
          reference: 'bullets',
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: d.LevelFormat.BULLET,
            text: bulletMarks[level % bulletMarks.length] as string,
            alignment: d.AlignmentType.LEFT,
            style: {
              paragraph: { indent: { left: (level + 1) * INDENT * 2, hanging: INDENT } },
            },
          })),
        },
        ...orderedLists.map(({ reference, start, depth }) => ({
          reference,
          levels: [
            {
              level: 0,
              format: d.LevelFormat.DECIMAL,
              text: '%1.',
              start,
              alignment: d.AlignmentType.LEFT,
              style: {
                paragraph: { indent: { left: (depth + 1) * INDENT * 2, hanging: INDENT } },
              },
            },
          ],
        })),
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 } } },
        children,
      },
    ],
  });

  return Buffer.from(await d.Packer.toBuffer(file));
}
