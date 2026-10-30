import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { desktop } from './desktop';
import './styles.css';

// What the window's glass can do depends on the system: styles.css reads it from here.
document.documentElement.dataset.platform = desktop().platform;

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
