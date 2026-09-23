'use client';
import { Accessibility, Check, Palette, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { type Preference, preferenceOptions } from '../../lib/preferences';
import { ThemePicker } from '../shell/theme-picker';
import { Field, SectionHeading } from '../ui';
import { Select } from '../ui/select';

function PreferenceField({
  preference,
  label,
  hint,
  labels,
}: {
  preference: Preference;
  label: string;
  hint: string;
  labels: string[];
}) {
  const [value, setValue] = useState<string>(preferenceOptions[preference][0]);
  useEffect(() => {
    const sync = () =>
      setValue(document.documentElement.dataset[preference] ?? preferenceOptions[preference][0]);
    sync();
    const storage = (event: StorageEvent) => {
      if (event.key !== `jian.${preference}` && event.key !== null) return;
      const next =
        preferenceOptions[preference].find((option) => option === event.newValue) ??
        preferenceOptions[preference][0];
      document.documentElement.dataset[preference] = next;
      sync();
    };
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
  }, [preference]);
  return (
    <Field label={label} hint={hint}>
      <Select
        value={value}
        options={preferenceOptions[preference].map((option, index) => ({
          value: option,
          label: labels[index] ?? option,
        }))}
        onValueChange={(next) => {
          document.documentElement.dataset[preference] = next;
          setValue(next);
          try {
            localStorage.setItem(`jian.${preference}`, next);
            toast.success('Preference saved.', { id: 'preference' });
          } catch {
            toast.error(
              'Applied for this session. The browser would not let the preference be saved.',
            );
          }
        }}
      />
    </Field>
  );
}

export function Settings({ tab }: { tab: 'appearance' | 'accessibility' }) {
  return (
    <>
      <SectionHeading
        title="Settings"
        description="Preferences of this browser, shared by all your profiles."
      />
      <nav className="settings-tabs" aria-label="Settings">
        <Link href="/settings/appearance" aria-current={tab === 'appearance' ? 'page' : undefined}>
          <Palette size={16} />
          Appearance
        </Link>
        <Link
          href="/settings/accessibility"
          aria-current={tab === 'accessibility' ? 'page' : undefined}
        >
          <Accessibility size={16} />
          Accessibility
        </Link>
      </nav>
      {tab === 'appearance' ? (
        <section className="appearance-panel">
          <div className="section-row">
            <div>
              <h2>Accent colour</h2>
              <p className="mt-1 text-sm">Five variations. The same workspace.</p>
            </div>
            <span className="preference-autosave">
              <Check size={14} />
              Saved automatically
            </span>
          </div>
          <ThemePicker />
          <div className="appearance-note">
            <SlidersHorizontal size={18} />
            <p>
              The theme follows you when you switch profiles. Alert colours keep the same meaning
              throughout.
            </p>
          </div>
        </section>
      ) : (
        <section className="accessibility-panel">
          <PreferenceField
            preference="motion"
            label="Motion"
            hint="The system's own reduce-motion setting is always respected."
            labels={['Follow the system', 'Reduce animation']}
          />
          <PreferenceField
            preference="text"
            label="Text size"
            hint="Enlarges text and controls across the panel."
            labels={['Default', 'Larger']}
          />
        </section>
      )}
    </>
  );
}
