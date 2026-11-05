import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * The search without ripgrep runs in a worker thread whose source is a function's own text, so
 * a bundler that wraps functions in helpers would break it in the published worker (minify with
 * keepNames makes it fail with "i is not defined"; build.ts must not use either). This bundles the
 * files code with build.ts's options and searches with no ripgrep on the path.
 */
{
  test('the bundled fallback search runs in its thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jian-bundled-'));
    try {
      const out = join(dir, 'bundle.mjs');
      await build({
        stdin: {
          contents: "export { answerFilesOp } from '@jian/remote-core';",
          resolveDir: import.meta.dirname,
          loader: 'ts',
        },
        outfile: out,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'silent',
      });
      const tree = join(dir, 'tree');
      mkdirSync(tree);
      writeFileSync(join(tree, 'a.txt'), 'one\nneedle here\n');
      const { answerFilesOp } = await import(pathToFileURL(out).href);
      const answer = await answerFilesOp(
        {
          op: 'search',
          path: tree,
          pattern: 'needle',
          ignoreCase: false,
          contextLines: 0,
          output: 'content',
          limit: 10,
        },
        { refused: [join(dir, 'none')], env: { PATH: join(dir, 'no-bin') } },
      );
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.equal(answer.matches.length, 1);
      assert.match(answer.matches[0], /a\.txt:2:needle here$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
