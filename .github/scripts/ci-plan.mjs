import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const areas = ['node', 'gateway', 'panel', 'desktop', 'remote', 'rust', 'triage'];

/** Follow package consumers as well as owners; unknown paths conservatively select every gate. */
export function plan(paths, full = false) {
  const result = Object.fromEntries(areas.map((name) => [name, full]));
  const enable = (...names) => {
    for (const name of names) result[name] = true;
  };
  for (const path of paths) {
    if (/^\.github\/(?:scripts\/issue-|workflows\/issue-triage\.yml|issue-triage\.md)/.test(path))
      enable('triage');
    else if (/^apps\/gateway\//.test(path)) enable('node', 'gateway', 'desktop');
    else if (/^packages\/ui\//.test(path)) enable('node', 'panel', 'desktop');
    else if (/^apps\/web\//.test(path)) enable('node', 'panel');
    else if (/^apps\/desktop\//.test(path)) enable('node', 'desktop');
    else if (/^packages\/contracts\//.test(path))
      enable('node', 'gateway', 'panel', 'desktop', 'remote');
    else if (/^packages\/sdk\//.test(path)) enable('node', 'panel', 'desktop');
    else if (/^packages\/remote-core\//.test(path)) {
      enable('node', 'remote', 'desktop', 'gateway');
      if (path.startsWith('packages/remote-core/native/')) enable('rust');
    } else if (/^apps\/remote-control\//.test(path)) enable('node', 'remote');
    else if (/^docs\/releases\//.test(path)) enable('node', 'gateway', 'panel', 'desktop');
    else if (/^(Cargo\.(toml|lock)|rust-toolchain(?:\.toml)?)$/.test(path))
      enable('rust', 'gateway', 'desktop', 'node');
    else if (/\.md$/.test(path) || path.startsWith('.github/ISSUE_TEMPLATE/')) continue;
    else enable(...areas);
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
      const range = `${base}${pr === 'true' ? '...' : '..'}${head}`;
      const paths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', range], {
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean);
      selected = plan(paths);
    }
  } catch {
    // A shallow/missing base or unusual ref must never silently skip required validation.
    selected = plan([], true);
  }
  const lines = Object.entries(selected)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  if (output) appendFileSync(output, `${lines}\n`);
  process.stdout.write(`${lines}\n`);
}
