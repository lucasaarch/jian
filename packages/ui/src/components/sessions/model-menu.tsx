'use client';

import { Popover } from '@base-ui/react/popover';
import { Check, ChevronDown, Search, Zap } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { InfoTip, SwitchControl } from '../../kit';
import type { ModelSelection, ReasoningEffort } from '../../lib/api';
import { matchesQuery } from '../../lib/search';
import { efforts } from '../providers/catalog';

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

const same = (entry: ModelEntry, selection?: ModelSelection) =>
  entry.providerId === selection?.providerId && entry.modelId === selection?.modelId;

/** Which edge of its trigger a menu lines up with: the end on the right of a bar, the start on its left. */
export type MenuAlign = 'start' | 'end';
/** Where a menu opens: above, as the composer sits at the bottom of the screen; or below. */
type MenuSide = 'top' | 'bottom';

/** A popup that opens beside its trigger, above it unless told otherwise. */
export function Menu({
  label,
  trigger,
  disabled,
  open,
  onOpenChange,
  align = 'end',
  side = 'top',
  children,
}: {
  label: string;
  trigger: ReactNode;
  align?: MenuAlign;
  side?: MenuSide;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger className="model-trigger" aria-label={label} disabled={disabled}>
        {trigger}
        <ChevronDown size={14} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="select-positioner"
          side={side}
          align={align}
          sideOffset={8}
          positionMethod="fixed"
          collisionBoundary={[]}
        >
          <Popover.Popup className="model-menu" aria-label={label}>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The model, behind a trigger that names it. The list is searchable and as wide as its names;
 * choosing a model keeps what it can of the current effort and speed.
 */
export function ModelMenu({
  label,
  models,
  value,
  disabled,
  align,
  side,
  off,
  onChange,
}: {
  label: string;
  models: ModelEntry[];
  value?: ModelSelection;
  disabled?: boolean;
  align?: MenuAlign;
  side?: MenuSide;
  /** For what may also run on no model at all: that choice, first in the list. */
  off?: { label: string; chosen: boolean; choose: () => void };
  onChange: (next: ModelSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = models.find((entry) => same(entry, value));
  const listed = models.filter((entry) => matchesQuery(`${entry.name} ${entry.provider}`, query));

  return (
    <Menu
      label={label}
      disabled={disabled}
      align={align}
      {...(side ? { side } : {})}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
      trigger={
        <span className="model-trigger-name">
          {off?.chosen ? off.label : (current?.name ?? 'No model available')}
        </span>
      }
    >
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
        {off && !query && (
          <li>
            <button
              type="button"
              className="model-option"
              aria-pressed={off.chosen}
              onClick={() => {
                off.choose();
                setOpen(false);
              }}
            >
              <span className="model-option-name">{off.label}</span>
              {off.chosen && <Check size={14} aria-hidden="true" />}
            </button>
          </li>
        )}
        {listed.map((entry) => {
          const chosen = !off?.chosen && same(entry, value);

          return (
            <li key={`${entry.providerId}:${entry.modelId}`}>
              <button
                type="button"
                className="model-option"
                aria-pressed={chosen}
                onClick={() => {
                  const effort = value?.reasoningEffort;

                  onChange({
                    providerId: entry.providerId,
                    modelId: entry.modelId,
                    ...(effort && entry.efforts.includes(effort)
                      ? { reasoningEffort: effort }
                      : {}),
                    ...(value?.fast && entry.fast ? { fast: true } : {}),
                  });
                  setOpen(false);
                }}
              >
                {entry.icon}
                <span className="model-option-name">{entry.name}</span>
                {entry.gone && <span className="model-option-detail">No longer offered</span>}
                {chosen && <Check size={14} aria-hidden="true" />}
              </button>
            </li>
          );
        })}
        {!listed.length && <li className="model-menu-empty">No model matches.</li>}
      </ul>
    </Menu>
  );
}

/**
 * How the current model thinks and how fast it answers: its reasoning efforts and, where the
 * vendor has it, Fast. Absent for a model that offers neither.
 */
export function EffortMenu({
  model,
  value,
  disabled,
  align,
  side,
  onChange,
}: {
  model?: ModelEntry;
  value?: ModelSelection;
  disabled?: boolean;
  align?: MenuAlign;
  side?: MenuSide;
  onChange: (next: ModelSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const fastId = useId();

  if (!model || !value || (!model.efforts.length && !model.fast)) return null;

  const offered = efforts.filter((effort) => model.efforts.includes(effort.value));
  const effort = offered.find((item) => item.value === value.reasoningEffort);
  const fast = model.fast && Boolean(value.fast);
  const summary = [effort?.label, fast ? 'Fast' : undefined].filter(Boolean).join(' ');

  return (
    <Menu
      label={`Effort for ${model.name}`}
      disabled={disabled}
      align={align}
      {...(side ? { side } : {})}
      open={open}
      onOpenChange={setOpen}
      trigger={<span className="model-trigger-name">{summary || 'Effort'}</span>}
    >
      {offered.length > 0 && (
        <fieldset aria-label="Effort">
          {offered.map((item) => {
            const active = value.reasoningEffort === item.value;

            return (
              <button
                key={item.value}
                type="button"
                className="model-option"
                aria-pressed={active}
                onClick={() => {
                  onChange({ ...value, reasoningEffort: item.value });
                  setOpen(false);
                }}
              >
                <span className="model-option-name">{item.label}</span>
                {active && <Check size={14} aria-hidden="true" />}
              </button>
            );
          })}
        </fieldset>
      )}
      {model.fast && (
        // Not a choice among the efforts but a switch beside them: one line, apart from the list.
        <div className="model-menu-switch">
          <Zap size={14} aria-hidden="true" />
          <span className="model-menu-switch-name" id={`${fastId}-label`}>
            Fast
          </span>
          <InfoTip label="About Fast">Quicker replies, at the provider's higher price.</InfoTip>
          <SwitchControl
            labelledBy={`${fastId}-label`}
            checked={fast}
            onCheckedChange={(next) => {
              const { fast: _off, ...rest } = value;
              onChange(next ? { ...rest, fast: true } : rest);
            }}
          />
        </div>
      )}
    </Menu>
  );
}
