import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Imports use the `@/` alias from tsconfig.json, which Vite resolves natively.
  resolve: { tsconfigPaths: true },
  test: { environment: 'happy-dom', setupFiles: ['./test/setup.ts'] },
});
