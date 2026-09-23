// Release notes are written by hand, one file per version in docs/releases. They are the source:
// CHANGELOG.md is generated from them, and the GitHub release of a tag carries its note.
//
//   node scripts/changelog.mjs            write CHANGELOG.md
//   node scripts/changelog.mjs --check    fail when CHANGELOG.md is not what the notes say
//   node scripts/changelog.mjs --notes V  print the note of version V, for the release
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const notesDir = join(root, 'docs/releases');
const target = join(root, 'CHANGELOG.md');

// 1.2.3 or 1.2.3-rc.1. Anything else in the folder is a mistake worth stopping on.
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parse(file) {
  const version = file.replace(/\.md$/, '');
  const match = VERSION.exec(version);

  if (!match) {
    throw new Error(`docs/releases/${file}: the name must be a version, such as 1.2.3.md`);
  }

  const text = readFileSync(join(notesDir, file), 'utf8');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const fields = Object.fromEntries(
    (front?.[1] ?? '').split('\n').flatMap((line) => {
      const split = line.indexOf(':');

      return split > 0 ? [[line.slice(0, split).trim(), line.slice(split + 1).trim()]] : [];
    }),
  );

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date ?? '')) {
    throw new Error(`docs/releases/${file}: start with a front matter holding date: YYYY-MM-DD`);
  }

  const body = text.slice(front[0].length).trim();

  if (!body) {
    throw new Error(`docs/releases/${file}: the note is empty`);
  }

  // The summary is the one sentence the panel's dialog leads with; notes before 2.2.0 have none.
  return { version, date: fields.date, summary: fields.summary, body, key: match.slice(1) };
}

/** Newest first; a release candidate sorts below the release it leads to. */
function compare(a, b) {
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(b.key[index]) - Number(a.key[index]);

    if (difference) return difference;
  }

  if (!a.key[3] !== !b.key[3]) return a.key[3] ? 1 : -1;

  return (b.key[3] ?? '').localeCompare(a.key[3] ?? '', 'en', { numeric: true });
}

const notes = readdirSync(notesDir)
  .filter((file) => file.endsWith('.md'))
  .map(parse)
  .sort(compare);

const [mode, value] = process.argv.slice(2);

if (mode === '--notes') {
  const note = notes.find((item) => item.version === value);

  if (!note) {
    console.error(`No docs/releases/${value}.md: write the note before tagging v${value}.`);
    process.exit(1);
  }

  process.stdout.write(`${note.summary ? `${note.summary}\n\n` : ''}${note.body}\n`);
  process.exit(0);
}

const changelog = [
  '# Changelog',
  '',
  'Every release of Jian, newest first.',
  '',
  '<!-- Generated from docs/releases by scripts/changelog.mjs. Edit a note there and run',
  '     `make changelog`; editing this file is editing the copy rather than the thing. -->',
  '',
  ...notes.flatMap((note) => [
    `## ${note.version} — ${note.date}`,
    '',
    ...(note.summary ? [note.summary, ''] : []),
    note.body,
    '',
  ]),
].join('\n');

if (mode === '--check') {
  let current = '';

  try {
    current = readFileSync(target, 'utf8');
  } catch {}

  if (current !== changelog) {
    console.error('CHANGELOG.md is not what docs/releases says. Run make changelog.');
    process.exit(1);
  }

  process.exit(0);
}

writeFileSync(target, changelog);
