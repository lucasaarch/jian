'use client';

import { Moon, Sun } from 'lucide-react';
import { useThemeChoice } from '../components/shell/theme';
import { Segmented, SettingsGroup } from '../kit';

/** The theme, as a settings page shows it. */
export function Appearance() {
  const { theme, setTheme } = useThemeChoice();
  return (
    <SettingsGroup title="Theme" description="Kept on this computer.">
      <Segmented
        label="Theme"
        value={theme}
        onChange={setTheme}
        options={[
          { value: 'dark', label: 'Dark', icon: <Moon size={14} /> },
          { value: 'light', label: 'Light', icon: <Sun size={14} /> },
        ]}
      />
    </SettingsGroup>
  );
}
