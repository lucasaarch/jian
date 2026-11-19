'use client';

import type { ArtifactTweak, ArtifactTweakValue } from '@jian/contracts';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useId } from 'react';
import {
  Action,
  ColorField,
  SectionHeading,
  Segmented,
  SelectField,
  SliderField,
  SwitchControl,
  TextField,
} from '../../../../kit';
import type { TweakScheme, Tweaks } from './use-tweaks';

const SCHEMES: { value: TweakScheme; label: string; icon: React.ReactNode }[] = [
  { value: 'auto', label: 'Auto', icon: <Monitor size={13} aria-hidden="true" /> },
  { value: 'light', label: 'Light', icon: <Sun size={13} aria-hidden="true" /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={13} aria-hidden="true" /> },
];

/** A few short choices are shown all at once; more, or long ones, open as a list. */
const fewChoices = (tweak: Extract<ArtifactTweak, { type: 'select' }>) =>
  tweak.options.length <= 3 && tweak.options.reduce((sum, one) => sum + one.label.length, 0) <= 18;

/** A field named above it, as the kit's fields are, for a control that has no name of its own. */
function Named({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
    </div>
  );
}

function TweakField({
  tweak,
  value,
  onChange,
}: {
  tweak: ArtifactTweak;
  value: ArtifactTweakValue | undefined;
  onChange: (value: ArtifactTweakValue) => void;
}) {
  const id = useId();

  switch (tweak.type) {
    case 'text':
      return (
        <TextField
          label={tweak.label}
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'number': {
      const { min, max, step } = tweak;
      if (min !== undefined && max !== undefined && max > min) {
        return (
          <SliderField
            label={tweak.label}
            value={Number(value ?? min)}
            min={min}
            max={max}
            {...(step ? { step } : {})}
            onValueChange={onChange}
          />
        );
      }
      return (
        <TextField
          label={tweak.label}
          type="number"
          value={String(value ?? 0)}
          {...(min === undefined ? {} : { min })}
          {...(max === undefined ? {} : { max })}
          {...(step ? { step } : {})}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            if (Number.isFinite(next)) onChange(next);
          }}
        />
      );
    }
    case 'boolean':
      return (
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span id={id} className="min-w-0 truncate text-[13px] font-medium text-ink">
            {tweak.label}
          </span>
          <SwitchControl checked={value === true} onCheckedChange={onChange} labelledBy={id} />
        </div>
      );
    case 'color':
      return (
        <ColorField label={tweak.label} value={String(value ?? '')} onValueChange={onChange} />
      );
    case 'select': {
      // Choices go by their place in the list: a value may be a number, a field's is text.
      const at = String(
        Math.max(
          0,
          tweak.options.findIndex((one) => one.value === value),
        ),
      );
      const options = tweak.options.map((one, index) => ({
        value: String(index),
        label: one.label,
      }));
      const pick = (index: string) => {
        const chosen = tweak.options[Number(index)];
        if (chosen) onChange(chosen.value);
      };
      return fewChoices(tweak) ? (
        <Named label={tweak.label}>
          <Segmented label={tweak.label} value={at} options={options} onChange={pick} />
        </Named>
      ) : (
        <SelectField label={tweak.label} value={at} options={options} onValueChange={pick} />
      );
    }
  }
}

/**
 * The props of a React component, to try it with others than the agent wrote, and the theme it
 * is drawn in. Beside the canvas, in the Artifact's view (artifact-view.tsx); on a phone, over
 * the lower half of it. What is set here is never saved.
 */
export function TweaksPanel({ tweaks }: { tweaks: Tweaks }) {
  const list = tweaks.tweaks;

  return (
    <aside
      aria-label="Tweaks"
      className="scroll-inset grid w-64 shrink-0 content-start gap-5 overflow-y-auto border-l border-line bg-canvas p-4 phone:absolute phone:inset-x-0 phone:bottom-0 phone:max-h-[55%] phone:w-full phone:border-t phone:border-l-0"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Tweaks</h3>
        <Action size="small" tone="quiet" disabled={!tweaks.changed} onClick={tweaks.reset}>
          Reset
        </Action>
      </div>
      <Named label="Theme">
        <Segmented
          label="Theme"
          value={tweaks.scheme}
          options={SCHEMES}
          onChange={(scheme) => tweaks.setScheme(scheme)}
        />
      </Named>
      {list && (
        <section className="grid min-w-0 grid-cols-1 gap-4">
          <SectionHeading title="Props" />
          {list.length === 0 ? (
            <p className="-mt-2 text-xs leading-relaxed text-muted">
              This component declares no props to tweak. Ask for some, and the agent exports them as
              its tweaks.
            </p>
          ) : (
            list.map((tweak) => (
              <TweakField
                key={tweak.key}
                tweak={tweak}
                value={tweaks.values[tweak.key]}
                onChange={(value) => tweaks.set(tweak.key, value)}
              />
            ))
          )}
        </section>
      )}
    </aside>
  );
}
