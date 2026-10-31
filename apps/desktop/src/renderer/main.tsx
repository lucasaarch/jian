import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/playfair-display/900.css';
import { CODE_RELOADED } from '@jian/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './styles.css';

// In development, a screen that broke while code was being edited heals when the fix arrives.
import.meta.hot?.on('vite:afterUpdate', () => window.dispatchEvent(new Event(CODE_RELOADED)));

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
