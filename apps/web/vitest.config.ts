import { defineConfig } from 'vitest/config';

// Only what runs on this server is tested here; the panel's screens are tested in @jian/ui.
export default defineConfig({ test: { environment: 'node' } });
