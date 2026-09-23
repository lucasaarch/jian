import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import '../app/globals.css';
import type { Preview } from '@storybook/nextjs-vite';
import { setupWorker } from 'msw/browser';
import { mswLoader } from 'msw-storybook-addon/csf3';
import { themes } from '../lib/themes';
import { handlers } from '../stories/handlers';

const preview: Preview = {
  loaders: [
    // A request no handler answers goes to the network, which in Storybook means it fails
    // visibly instead of being made up.
    mswLoader(async () => {
      const worker = setupWorker();

      await worker.start({
        onUnhandledRequest: 'bypass',
        quiet: true,
        serviceWorker: { url: './mockServiceWorker.js' },
      });

      return worker;
    }),
  ],
  parameters: {
    layout: 'fullscreen',
    nextjs: { appDirectory: true },
    msw: { handlers },
    a11y: { test: 'todo' },
    controls: { expanded: true },
  },
  globalTypes: {
    theme: {
      description: 'The panel theme',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        items: themes.map((theme) => ({
          value: theme.id,
          title: `${theme.name} · ${theme.pilot}`,
        })),
        dynamicTitle: true,
      },
    },
    mode: {
      description: 'Light or dark',
      toolbar: {
        title: 'Mode',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
    text: {
      description: 'Text size preference',
      toolbar: {
        title: 'Text',
        icon: 'paragraph',
        items: [
          { value: 'default', title: 'Default text' },
          { value: 'large', title: 'Large text' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'strelizia', mode: 'light', text: 'default' },
  decorators: [
    // The panel reads its theme and text size from the root element, as the head script sets.
    (Story, { globals }) => {
      document.documentElement.dataset.theme = String(globals.theme ?? 'strelizia');
      document.documentElement.dataset.mode = String(globals.mode ?? 'light');
      document.documentElement.dataset.text = String(globals.text ?? 'default');

      return <Story />;
    },
  ],
};

export default preview;
