import type { StorybookConfig } from '@storybook/nextjs-vite';
import tailwindcss from '@tailwindcss/vite';

/**
 * Components and whole pages, without a gateway: every request the panel makes is answered by
 * the handlers in stories/handlers.ts. The service worker that answers them lives in
 * .storybook/public so it never ships with the panel.
 */
const config: StorybookConfig = {
  stories: ['../components/**/*.stories.tsx', '../stories/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', 'msw-storybook-addon'],
  framework: { name: '@storybook/nextjs-vite', options: {} },
  staticDirs: ['../public', './public'],
  core: { disableTelemetry: true },
  // Next reads Tailwind through PostCSS; under Vite its own plugin resolves the stylesheet's
  // imports, and the PostCSS pass is turned off so the CSS is not processed twice.
  viteFinal: async (vite) => ({
    ...vite,
    plugins: [...(vite.plugins ?? []), tailwindcss()],
    css: { ...vite.css, postcss: { plugins: [] } },
  }),
};

export default config;
