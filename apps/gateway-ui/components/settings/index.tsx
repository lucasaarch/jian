'use client';
import { Accessibility, Check, Palette, Server, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { type Preference, preferenceOptions } from '../../lib/preferences';
import { timeZones } from '../../lib/time';
import { useWorkspace } from '../../lib/workspace';
import { AccentPicker, ModePicker } from '../shell/theme-picker';
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

/** The whole installation's settings, shared by every profile and every browser. */
function GatewaySettingsPanel() {
  const { api } = useWorkspace();
  const [settings, setSettings] = useState<{ timeZone: string; timeZoneSource: string }>();

  useEffect(() => {
    void api
      .settings()
      .then(setSettings)
      .catch(() => {});
  }, [api]);

  return (
    <section className="accessibility-panel">
      <Field
        label="Time zone"
        hint={
          settings?.timeZoneSource === 'host'
            ? 'Following the machine the gateway runs on. Agents read the time in it, and schedules run by it.'
            : 'Agents read the time in it, and schedules run by it.'
        }
      >
        <Select
          value={settings?.timeZone ?? ''}
          placeholder="Loading…"
          options={timeZones().map((value) => ({ value, label: value.replaceAll('_', ' ') }))}
          onValueChange={(timeZone) =>
            void api
              .updateSettings(timeZone)
              .then((next) => {
                setSettings(next);
                toast.success('Time zone saved.', { id: 'time-zone' });
              })
              .catch((failure) =>
                toast.error(failure instanceof Error ? failure.message : 'Could not save.'),
              )
          }
          aria-label="Time zone"
        />
      </Field>
    </section>
  );
}

export function Settings({ tab }: { tab: 'appearance' | 'accessibility' | 'gateway' }) {
  return (
    <>
      <SectionHeading
        title="Settings"
        description={
          tab === 'gateway'
            ? 'Settings of this Jian, shared by every profile.'
            : 'Preferences of this browser, shared by all your profiles.'
        }
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
        <Link href="/settings/gateway" aria-current={tab === 'gateway' ? 'page' : undefined}>
          <Server size={16} />
          Gateway
        </Link>
      </nav>
      {tab === 'gateway' ? (
        <GatewaySettingsPanel />
      ) : tab === 'appearance' ? (
        <section className="appearance-panel">
          <div className="section-row">
            <div>
              <h2>Mode</h2>
              <p className="mt-1 text-sm">
                System follows the light or dark setting of this device.
              </p>
            </div>
            <span className="preference-autosave">
              <Check size={14} />
              Saved automatically
            </span>
          </div>
          <ModePicker />
          <div className="section-row mt-10">
            <div>
              <h2>Accent colour</h2>
              <p className="mt-1 text-sm">Five colours, each tuned for light and for dark.</p>
            </div>
          </div>
          <AccentPicker />
          <div className="appearance-note">
            <SlidersHorizontal size={18} />
            <p>
              Both follow you when you switch profiles. Alert colours keep the same meaning
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
