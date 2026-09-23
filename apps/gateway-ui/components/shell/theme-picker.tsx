'use client';

import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  isMode,
  isTheme,
  type Mode,
  modeKey,
  modes,
  type ThemeId,
  themeKey,
  themes,
} from '../../lib/themes';

/**
 * A preference kept by this browser and mirrored on the root element, where the stylesheet
 * reads it. Another tab changing it is followed here too.
 */
function useRootPreference<T extends string>(
  key: string,
  attribute: 'theme' | 'mode',
  fallback: T,
  valid: (value: unknown) => value is T,
) {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    const current = document.documentElement.dataset[attribute];

    if (valid(current)) setValue(current);

    const sync = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;

      const next = valid(event.newValue) ? event.newValue : fallback;

      document.documentElement.dataset[attribute] = next;
      setValue(next);
    };

    window.addEventListener('storage', sync);

    return () => window.removeEventListener('storage', sync);
  }, [key, attribute, fallback, valid]);

  const choose = (next: T, done: string) => {
    document.documentElement.dataset[attribute] = next;
    setValue(next);

    try {
      localStorage.setItem(key, next);
      toast.success(done, { id: attribute });
    } catch {
      toast.error('Applied for this session. The browser would not let it be saved.');
    }
  };

  return [value, choose] as const;
}

const modeOptions: Record<Mode, { label: string; icon: typeof Sun }> = {
  system: { label: 'System', icon: Monitor },
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon },
};

export function ModePicker() {
  const [mode, choose] = useRootPreference<Mode>(modeKey, 'mode', 'system', isMode);

  return (
    <fieldset className="mode-picker">
      <legend className="sr-only">Mode</legend>
      {modes.map((option) => {
        const { label, icon: Icon } = modeOptions[option];

        return (
          <label key={option} className="mode-option">
            <input
              type="radio"
              name="mode"
              value={option}
              checked={mode === option}
              onChange={() => choose(option, `${label} mode.`)}
            />
            <Icon size={16} aria-hidden="true" />
            {label}
          </label>
        );
      })}
    </fieldset>
  );
}

export function AccentPicker() {
  const [theme, choose] = useRootPreference<ThemeId>(themeKey, 'theme', 'strelizia', isTheme);

  return (
    <fieldset className="accent-picker">
      <legend className="sr-only">Accent colour</legend>
      {themes.map((option) => (
        <label
          key={option.id}
          className="accent-option"
          data-theme={option.id}
          title={`${option.name} · ${option.pilot}`}
        >
          <input
            type="radio"
            name="accent"
            value={option.id}
            aria-label={`${option.name} — ${option.color}`}
            checked={theme === option.id}
            onChange={() => choose(option.id, `${option.name} accent.`)}
          />
          <span className="accent-swatch" aria-hidden="true">
            <Check size={16} strokeWidth={3} />
          </span>
          <span className="accent-name">{option.name}</span>
        </label>
      ))}
    </fieldset>
  );
}
