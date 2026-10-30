import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

/**
 * Three builds: the main process and its preload bundle every dependency they use, so the
 * packaged app carries no node_modules; the renderer is the panel, @jian/ui compiled from source.
 */
export default defineConfig({
  main: {
    build: { externalizeDeps: false },
  },
  preload: {
    build: {
      externalizeDeps: false,
      // A sandboxed preload must be CommonJS, whatever the package's own module type.
      rolldownOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
