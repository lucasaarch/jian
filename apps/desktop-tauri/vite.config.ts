import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const isTauri = mode === 'tauri';

  return {
    base: isTauri ? './' : '/',
    plugins: [
      react(),
      {
        name: 'jian-host-entry',
        transformIndexHtml(html: string) {
          return isTauri ? html.replace('/src/host/web.tsx', '/src/host/tauri.tsx') : html;
        },
      },
    ],
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    build: {
      outDir: isTauri ? 'dist/tauri' : 'dist/web',
    },
  };
});
