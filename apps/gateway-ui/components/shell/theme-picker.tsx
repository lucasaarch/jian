'use client';

import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { isTheme, type ThemeId, themeKey, themes } from '../../lib/themes';

export function ThemePicker() {
  const [selected, setSelected] = useState<ThemeId>('strelizia');
  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (isTheme(current)) setSelected(current);
    const sync = (event: StorageEvent) => {
      if (event.key !== themeKey && event.key !== null) return;
      const next = isTheme(event.newValue) ? event.newValue : 'strelizia';
      document.documentElement.dataset.theme = next;
      setSelected(next);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  return (
    <fieldset className="theme-picker">
      <legend className="sr-only">Squad 13 theme</legend>
      <div className="theme-grid">
        {themes.map((theme) => (
          <label
            key={theme.id}
            data-theme={theme.id}
            className="theme-option"
            title={`${theme.name} · ${theme.pilot}`}
          >
            <input
              type="radio"
              name="theme"
              value={theme.id}
              aria-label={`${theme.name} — ${theme.pilot} (${theme.color})`}
              checked={selected === theme.id}
              onChange={() => {
                document.documentElement.dataset.theme = theme.id;
                setSelected(theme.id);
                try {
                  localStorage.setItem(themeKey, theme.id);
                  toast.success(`Tema ${theme.name} aplicado.`, { id: 'theme' });
                } catch {
                  toast.error(
                    'Theme applied for this session. The browser would not let it be saved.',
                  );
                }
              }}
            />
            <span className="theme-preview" aria-hidden="true">
              <span className="preview-rail">
                <i />
                <i />
                <i />
              </span>
              <span className="preview-page">
                <span className="preview-title" />
                <span className="preview-line" />
                <span className="preview-stats">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="preview-button" />
              </span>
            </span>
            <span className="theme-card-caption">
              <span>
                <strong>{theme.name}</strong>
                <small>{theme.pilot}</small>
              </span>
              <span className="theme-indicator">
                {selected === theme.id ? <Check size={13} /> : null}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
