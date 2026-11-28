import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '../styles.css';

export function mountApp() {
  const rootElement = document.getElementById('root');

  if (!rootElement) {
    throw new Error('The Jian panel root element is missing.');
  }

  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
