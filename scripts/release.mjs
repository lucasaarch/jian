// Cuts a release: `make release VERSION=1.2.3`. The note comes first — it is the changelog
// entry and the GitHub release — and the tag comes last; the Image workflow does the rest.
// Everything that can be wrong is checked before anything is written or pushed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const stop = (message) => {
  console.error(message);
  process.exit(1);
};

const version = process.argv[2] ?? '';

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  stop('usage: make release VERSION=1.2.3   (or 1.2.3-rc.1 for a candidate)');
}

if (!existsSync(join(root, `docs/releases/${version}.md`))) {
  stop(
    `Write docs/releases/${version}.md first: it is the CHANGELOG entry and the GitHub release.`,
  );
}

if (git('branch', '--show-current') !== 'main') {
  stop('Release from main.');
}

if (git('status', '--porcelain')) {
  stop('The working tree has changes: commit or stash them first.');
}

git('fetch', '--quiet', '--tags', 'origin', 'main');

if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
  stop('main is not what origin/main is: pull or push first, so the tag names a published commit.');
}

if (git('tag', '--list', `v${version}`)) {
  stop(`v${version} already exists. A published version is never moved; release the next one.`);
}

// The version the image reports and the changelog the repository shows are written from the
// note. When either changes, the change is committed by a person, not pushed from here.
const manifest = join(root, 'package.json');
const current = JSON.parse(readFileSync(manifest, 'utf8'));

if (current.version !== version) {
  writeFileSync(manifest, `${JSON.stringify({ ...current, version }, null, 2)}\n`);
}

execFileSync('node', [join(root, 'scripts/changelog.mjs')], { stdio: 'inherit' });

if (git('status', '--porcelain')) {
  stop(
    `package.json and CHANGELOG.md now say ${version}. Commit them ("chore: release ${version}"), push, then run this again.`,
  );
}

git('tag', '-a', `v${version}`, '-m', `Jian ${version}`);
git('push', 'origin', `v${version}`);

console.log(`Tagged v${version}. The Image workflow builds it and publishes the release.`);
