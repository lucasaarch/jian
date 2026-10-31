import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const areas = [
  'quality',
  'gateway',
  'web',
  'ui',
  'desktop',
  'remote',
  'rust',
  'postgres',
  'triage',
  'contracts',
  'display',
  'imageGateway',
  'imageWeb',
];
const images = new Set(['imageGateway', 'imageWeb']);
const nodeConsumers = [
  'quality',
  'gateway',
  'web',
  'ui',
  'desktop',
  'remote',
  'postgres',
  'contracts',
];

/** Select consumers of changed source; Docker builds require a positive Dockerfile change. */
export function plan(paths, full = false) {
  const result = Object.fromEntries(areas.map((name) => [name, full && !images.has(name)]));
  const enable = (...names) => {
    for (const name of names) result[name] = true;
  };
  for (const path of paths) {
    if (path === 'apps/gateway/Dockerfile') enable('imageGateway');
    else if (path === 'apps/web/Dockerfile') enable('imageWeb');
    else if (
      /^\.github\/(?:scripts\/issue-|workflows\/issue-triage\.yml|issue-triage\.md)/.test(path)
    )
      enable('quality', 'triage');
    else if (path.startsWith('.github/') || path === '.gitignore' || path.startsWith('.husky/'))
      enable('quality');
    else if (/^apps\/gateway\/test-display/.test(path) || path === 'apps/gateway/display.sh')
      enable('display');
    else if (path === 'apps/gateway/tests/postgres.test.ts') enable('postgres');
    else if (/^apps\/gateway\/(?:tests\/|vitest)/.test(path)) {
      enable('gateway');
      if (path.includes('/vitest')) enable('postgres');
    } else if (path.startsWith('apps/gateway/')) enable('gateway', 'postgres', 'desktop');
    else if (path.startsWith('packages/ui/')) enable('web', 'ui', 'desktop');
    else if (path.startsWith('apps/web/')) enable('web');
    else if (path.startsWith('apps/desktop/')) enable('desktop');
    else if (path.startsWith('packages/contracts/')) enable(...nodeConsumers);
    else if (path.startsWith('packages/sdk/'))
      enable('quality', 'contracts', 'web', 'ui', 'desktop');
    else if (path.startsWith('packages/remote-core/')) {
      enable('remote', 'desktop');
      if (path.startsWith('packages/remote-core/native/')) enable('rust');
    } else if (path.startsWith('apps/remote-control/')) enable('remote');
    else if (path.startsWith('docs/releases/')) enable('quality', 'gateway', 'web', 'desktop');
    else if (/^(Cargo\.(toml|lock)|rust-toolchain(?:\.toml)?)$/.test(path))
      enable('rust', 'remote', 'desktop');
    else if (/\.md$/.test(path)) continue;
    else if (/^(package\.json|pnpm-[^/]+|tsconfig[^/]*|biome\.json)$/.test(path))
      enable(...nodeConsumers);
    else if (path.startsWith('scripts/')) enable(...nodeConsumers);
    else enable(...areas.filter((name) => !images.has(name)));
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    CI_BASE: base,
    CI_HEAD: head,
    CI_PR: pr,
    CI_FULL: full,
    GITHUB_OUTPUT: output,
  } = process.env;
  let selected;
  try {
    if (
      full === 'true' ||
      !/^[a-f0-9]{40}$/.test(base ?? '') ||
      /^0+$/.test(base) ||
      !/^[a-f0-9]{40}$/.test(head ?? '')
    )
      selected = plan([], true);
    else {
      if (pr !== 'true') execFileSync('git', ['merge-base', '--is-ancestor', base, head]);
      const range = `${base}${pr === 'true' ? '...' : '..'}${head}`;
      const paths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', range], {
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean);
      selected = plan(paths);
    }
  } catch {
    selected = plan([], true);
  }
  const lines = Object.entries(selected)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  if (output) appendFileSync(output, `${lines}\n`);
  process.stdout.write(`${lines}\n`);
}
