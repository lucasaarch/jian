import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CLI mocks, timers and schema mutations belong to their test file. CI divides files into
    // shards to reduce wall time while retaining this boundary within each runner.
    isolate: true,
    // Each worker boots PostgreSQL compiled to WebAssembly. One per core starves them of
    // memory and turns real work into timeouts, so the pool is deliberately small.
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // A run writes keys to the agents' directory and prunes them from it. Without this, a test file
    // naming no root of its own would do that in `~/workspaces`, a developer's real gateway's default.
    env: { JIAN_WORKSPACES: mkdtempSync(join(tmpdir(), 'jian-test-workspaces-')) },
  },
});
