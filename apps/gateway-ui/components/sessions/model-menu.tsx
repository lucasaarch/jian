'use client';

import { Popover } from '@base-ui/react/popover';
import { Check, ChevronDown, Search } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { ModelSelection, ReasoningEffort } from '@/lib/api';
import { matchesQuery } from '@/lib/search';
import { efforts } from '../providers/catalog';
import { Switch } from '../ui';

/** One model the conversation can run on, as the menu shows it. */
export type ModelEntry = {
  providerId: string;
  modelId: string;
  name: string;
  provider: string;
  icon?: ReactNode;
  efforts: ReasoningEffort[];
  fast: boolean;
  /** A model the conversation still names but the provider no longer offers. */
  gone?: boolean;
};

const effortName = (effort?: ReasoningEffort) =>
  efforts.find((item) => item.value === effort)?.label;

const same = (entry: ModelEntry, selection?: ModelSelection) =>
  entry.providerId === selection?.providerId && entry.modelId === selection?.modelId;

/**
 * The model, its effort and its speed, behind one compact trigger: "Claude Opus 5.5 Low". The
 * list is on the left, searchable; what the model under the pointer offers is on the right, so
 * a model and how it thinks are picked in one place, and choosing an effort or Fast for a model
 * that is not the current one switches to it.
 */
export function ModelMenu({
  label,
  models,
  value,
  disabled,
  onChange,
}: {
  label: string;
  models: ModelEntry[];
  value?: ModelSelection;
  disabled?: boolean;
  onChange: (next: ModelSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = models.find((entry) => same(entry, value));
  // What the options panel describes: the model the pointer or the keyboard is on, else the
  // current one.
  const [focus, setFocus] = useState<string>();
  const shown = models.find((entry) => `${entry.providerId}:${entry.modelId}` === focus) ?? current;
  const listed = models.filter((entry) => matchesQuery(`${entry.name} ${entry.provider}`, query));

  /** The model with what it can keep of the current effort and speed. */
  const choose = (entry: ModelEntry, change: Partial<ModelSelection> = {}) => {
    const keep = same(entry, value) ? value : undefined;
    const effort = change.reasoningEffort ?? keep?.reasoningEffort ?? value?.reasoningEffort;
    const fast = change.fast ?? keep?.fast ?? value?.fast;

    onChange({
      providerId: entry.providerId,
      modelId: entry.modelId,
      ...(effort && entry.efforts.includes(effort) ? { reasoningEffort: effort } : {}),
      ...(fast && entry.fast ? { fast: true } : {}),
    });
  };

  const summary = [
    effortName(current && value?.reasoningEffort),
    current?.fast && value?.fast ? 'Fast' : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery('');
          setFocus(undefined);
        }
      }}
    >
      <Popover.Trigger className="model-trigger" aria-label={label} disabled={disabled}>
        <span className="model-trigger-name">{current?.name ?? 'No model available'}</span>
        {summary && <span className="model-trigger-detail">{summary}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="select-positioner"
          side="top"
          align="end"
          sideOffset={8}
          positionMethod="fixed"
          collisionBoundary={[]}
        >
          <Popover.Popup className="model-menu" aria-label={label}>
            <div className="model-menu-list">
              <label className="model-menu-search">
                <Search size={14} aria-hidden="true" />
                <input
                  aria-label="Search models"
                  placeholder="Search models"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <ul aria-label="Models">
                {listed.map((entry) => {
                  const key = `${entry.providerId}:${entry.modelId}`;
                  const chosen = same(entry, value);

                  return (
                    <li key={key}>
                      <button
                        type="button"
                        className="model-option"
                        aria-pressed={chosen}
                        data-focused={shown === entry || undefined}
                        onPointerEnter={() => setFocus(key)}
                        onFocus={() => setFocus(key)}
                        onClick={() => {
                          choose(entry);
                          setOpen(false);
                        }}
                      >
                        {entry.icon}
                        <span className="model-option-name">{entry.name}</span>
                        {chosen && value?.reasoningEffort && (
                          <span className="model-option-detail">
                            {effortName(value.reasoningEffort)}
                            {entry.fast && value.fast ? ' Fast' : ''}
                          </span>
                        )}
                        {entry.gone && (
                          <span className="model-option-detail">No longer offered</span>
                        )}
                      </button>
                    </li>
                  );
                })}
                {!listed.length && <li className="model-menu-empty">No model matches.</li>}
              </ul>
            </div>
            {shown && (shown.efforts.length > 0 || shown.fast) && (
              <section className="model-menu-options" aria-label={`${shown.name} options`}>
                {shown.efforts.length > 0 && (
                  <fieldset>
                    <legend>Effort</legend>
                    {efforts
                      .filter((effort) => shown.efforts.includes(effort.value))
                      .map((effort) => {
                        const active =
                          same(shown, value) && value?.reasoningEffort === effort.value;

                        return (
                          <button
                            key={effort.value}
                            type="button"
                            className="model-option"
                            aria-pressed={active}
                            onClick={() => choose(shown, { reasoningEffort: effort.value })}
                          >
                            <span className="model-option-name">{effort.label}</span>
                            {active && <Check size={14} aria-hidden="true" />}
                          </button>
                        );
                      })}
                  </fieldset>
                )}
                {shown.fast && (
                  <fieldset>
                    <legend>Options</legend>
                    <div className="model-option static">
                      <span className="model-option-name">
                        Fast
                        <small>Faster answers, at the provider's higher price</small>
                      </span>
                      <Switch
                        label={`Fast mode for ${shown.name}`}
                        checked={same(shown, value) && Boolean(value?.fast)}
                        onChange={(fast) => choose(shown, { fast })}
                      />
                    </div>
                  </fieldset>
                )}
              </section>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
