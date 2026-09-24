import { strFromU8, unzipSync } from 'fflate';

/**
 * Office and OpenDocument files are zip archives of XML. Their text is enough for the agent to
 * read a contract, a report or a spreadsheet; layout, images and formulas are left behind.
 */

/** Bounds what a hostile archive can expand to: a zip bomb stops here, not in memory. */
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;

const OFFICE_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

export const isOfficeDocument = (mimeType: string) => OFFICE_TYPES.has(mimeType);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity] ?? whole;
  });
}

/** Paragraph ends become new lines and tabs stay tabs; every other tag is dropped. */
function flatten(xml: string, paragraph: RegExp, tab: RegExp) {
  return decode(
    xml
      .replace(tab, '\t')
      .replace(paragraph, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function unzip(data: Buffer) {
  let expanded = 0;

  return unzipSync(new Uint8Array(data), {
    filter: (file) => {
      expanded += file.originalSize;
      if (expanded > MAX_EXPANDED_BYTES) throw new Error('The document expands past 64 MB');
      return file.name.endsWith('.xml');
    },
  });
}

const numbered = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

function sheetText(files: Record<string, Uint8Array>) {
  const shared = [
    ...strFromU8(files['xl/sharedStrings.xml'] ?? new Uint8Array()).matchAll(
      /<si>([\s\S]*?)<\/si>/g,
    ),
  ].map((match) => decode((match[1] ?? '').replace(/<[^>]+>/g, '')));
  const names = [
    ...strFromU8(files['xl/workbook.xml'] ?? new Uint8Array()).matchAll(
      /<sheet [^>]*name="([^"]*)"/g,
    ),
  ].map((match) => decode(match[1] ?? ''));

  return Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => numbered(a) - numbered(b))
    .map((name, index) => {
      const rows = [
        ...strFromU8(files[name] as Uint8Array).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g),
      ]
        .map((row) =>
          [...(row[1] ?? '').matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
            .map(([, attributes = '', body = '']) => {
              const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
              if (attributes.includes('t="s"')) return shared[Number(value)] ?? '';
              if (attributes.includes('t="inlineStr"')) return decode(body.replace(/<[^>]+>/g, ''));
              return decode(value ?? '');
            })
            .join('\t'),
        )
        .filter((row) => row.trim());

      return `## ${names[index] ?? `Sheet ${index + 1}`}\n${rows.join('\n')}`;
    })
    .join('\n\n');
}

/** The text of a DOCX, XLSX, PPTX, ODT, ODS or ODP file; throws when it is not one. */
export function officeText(mimeType: string, data: Buffer) {
  const files = unzip(data);
  const read = (name: string) => strFromU8(files[name] ?? new Uint8Array());

  if (mimeType.includes('wordprocessingml')) {
    return flatten(read('word/document.xml'), /<\/w:p>/g, /<w:tab\/>/g);
  }

  if (mimeType.includes('spreadsheetml')) {
    return sheetText(files);
  }

  if (mimeType.includes('presentationml')) {
    return Object.keys(files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => numbered(a) - numbered(b))
      .map(
        (name, index) => `## Slide ${index + 1}\n${flatten(read(name), /<\/a:p>/g, /<a:tab\/>/g)}`,
      )
      .join('\n\n');
  }

  // OpenDocument keeps every kind in content.xml: paragraphs, headings and table cells.
  return flatten(
    read('content.xml').replace(/<\/table:table-cell>/g, '\t'),
    /<\/text:(p|h)>|<\/table:table-row>/g,
    /<text:tab\/>/g,
  );
}
