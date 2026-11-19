import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The image installs only `dependencies` (pnpm deploy --prod). A package the compiled gateway
// imports from a devDependency is missing there, and the server dies before it listens.
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  dependencies: Record<string, string>;
};

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });

const packageOf = (specifier: string) =>
  specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : (specifier.split('/')[0] ?? specifier);

describe('gateway runtime imports', () => {
  it('come from dependencies, which the production image installs', () => {
    const src = new URL('src/', root).pathname;
    const missing = new Set<string>();
    const statics = /^\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s+'([^'./][^']*)'/gm;
    const dynamics = /(?<!typeof\s)\bimport\(\s*'([^'./][^']*)'\s*\)/g;

    for (const file of sources(src)) {
      const text = readFileSync(file, 'utf8');
      for (const [, specifier] of [...text.matchAll(statics), ...text.matchAll(dynamics)]) {
        if (!specifier || specifier.startsWith('node:') || builtinModules.includes(specifier)) {
          continue;
        }
        const name = packageOf(specifier);
        if (!manifest.dependencies[name]) missing.add(`${name} (${file.slice(src.length)})`);
      }
    }

    expect([...missing]).toEqual([]);
  });
});
