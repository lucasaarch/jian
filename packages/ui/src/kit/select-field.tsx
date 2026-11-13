'use client';

import { Combobox } from '@base-ui/react/combobox';
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { type ReactNode, useId, useRef } from 'react';
import { matchesQuery } from '../lib/search';
import { searchBox } from './search-field';
import { bareInput, control, Labelled } from './text-field';

export type FieldOption = {
  value: string;
  label: string;
  /** Said after the name, quieter: where a conversation is, what a choice means. */
  detail?: string;
  icon?: ReactNode;
};

/** From this many options on, the list can be searched. */
const SEARCH_FROM = 8;
/** Chips a multiple choice shows in its field; the rest are counted, so the field keeps its height. */
const CHIPS_SHOWN = 2;

// The list is as wide as the field, so it never runs past the form it sits in, and rides above
// the overlay the form is drawn in.
const positioner = 'z-[60]';
const popup =
  'glass grid max-h-[min(20rem,var(--available-height))] origin-(--transform-origin) overflow-hidden rounded-xl text-[13px] text-ink outline-none transition-[opacity,scale] duration-100 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0';
const list = 'scroll-inset grid min-h-0 content-start gap-px overflow-y-auto p-1 outline-none';
const item =
  'flex h-9 min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 outline-none select-none data-disabled:opacity-45 data-highlighted:bg-glass-press';
const trigger = `${control} flex h-10 min-w-0 items-center gap-2.5 text-left data-popup-open:border-ink/25 data-popup-open:bg-glass-press`;
/** The small outline button's look, as `Action tone="outline" size="small"` draws it. */
const buttonTrigger =
  'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-glass-edge bg-glass-hover px-2.5 text-xs font-medium text-ink transition-colors hover:bg-glass-press disabled:pointer-events-none disabled:opacity-45 data-popup-open:bg-glass-press';

function Option({ option }: { option: FieldOption }) {
  return (
    <>
      {option.icon && (
        <span className="grid size-4 shrink-0 place-items-center text-muted">{option.icon}</span>
      )}
      <span className="min-w-0 flex-1 truncate">
        {option.label}
        {option.detail && <span className="text-muted"> · {option.detail}</span>}
      </span>
    </>
  );
}

/** The options a search leaves, ticked when chosen: what both searchable lists draw. */
function Matches() {
  return (
    <div className="grid min-h-0">
      <Combobox.Empty className="px-3 py-3 text-[13px] text-muted empty:hidden">
        Nothing matches.
      </Combobox.Empty>
      <Combobox.List className={list}>
        {(option: FieldOption) => (
          <Combobox.Item key={option.value} value={option} className={item}>
            <Option option={option} />
            <Combobox.ItemIndicator className="shrink-0">
              <Check size={14} aria-hidden="true" />
            </Combobox.ItemIndicator>
          </Combobox.Item>
        )}
      </Combobox.List>
    </div>
  );
}

const matches = (option: FieldOption, query: string) =>
  matchesQuery(`${option.label} ${option.detail ?? ''}`, query);

function Shown({ option, placeholder }: { option?: FieldOption; placeholder: string }) {
  return (
    <>
      {option ? (
        <Option option={option} />
      ) : (
        <span className="flex-1 text-muted/70">{placeholder}</span>
      )}
      <ChevronDown size={15} aria-hidden="true" className="shrink-0 text-muted" />
    </>
  );
}

type ChoiceProps = {
  /** What the list is called, for assistive technology, and what its search says. */
  label: string;
  value: string;
  options: FieldOption[];
  onValueChange: (value: string) => void;
  disabled: boolean;
  searchable: boolean;
  /** The trigger's look, and what it shows. */
  triggerClass: string;
  shown: ReactNode;
  /** How wide the list is: the field's width, or a width of its own for a small button. */
  width: string;
  triggerProps?: Record<string, string | undefined>;
};

/** The trigger and its list, searchable when asked: what a field and a button choose with. */
function Choice({
  label,
  value,
  options,
  onValueChange,
  disabled,
  searchable,
  triggerClass,
  shown,
  width,
  triggerProps = {},
}: ChoiceProps) {
  const chosen = options.find((option) => option.value === value);
  const positioned = `${positioner} ${width}`;

  if (searchable) {
    return (
      <Combobox.Root
        items={options}
        value={chosen ?? null}
        onValueChange={(next: FieldOption | null) => next && onValueChange(next.value)}
        isItemEqualToValue={(a: FieldOption, b: FieldOption) => a.value === b.value}
        filter={matches}
        disabled={disabled}
      >
        <Combobox.Trigger {...triggerProps} className={triggerClass}>
          {shown}
        </Combobox.Trigger>
        <Combobox.Portal>
          <Combobox.Positioner side="bottom" align="start" sideOffset={6} className={positioned}>
            <Combobox.Popup aria-label={label} className={`${popup} grid-rows-[auto_1fr]`}>
              <div className="flex h-10 items-center gap-2 border-b border-glass-edge px-3 text-muted">
                <Search size={14} aria-hidden="true" />
                <Combobox.Input
                  aria-label={`Search ${label.toLowerCase()}`}
                  placeholder="Search"
                  className={`${bareInput} text-[13px]`}
                />
              </div>
              <Matches />
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    );
  }

  return (
    <Select.Root
      items={options}
      value={value}
      onValueChange={(next: string | null) => next !== null && onValueChange(next)}
      disabled={disabled}
    >
      <Select.Trigger {...triggerProps} className={triggerClass}>
        {shown}
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          side="bottom"
          align="start"
          sideOffset={6}
          alignItemWithTrigger={false}
          className={positioned}
        >
          <Select.Popup aria-label={label} className={popup}>
            <Select.List className={list}>
              {options.map((option) => (
                <Select.Item key={option.value} value={option.value} className={item}>
                  <Option option={option} />
                  <Select.ItemIndicator className="shrink-0">
                    <Check size={14} aria-hidden="true" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

/**
 * A choice that takes a form's whole row, labelled as the kit's text fields are. Its list opens
 * under it, as wide as it is; a long one, or one asked to, has a search at its top, matching
 * names and details.
 */
export function SelectField({
  label,
  hint,
  value,
  options,
  onValueChange,
  placeholder = 'Choose',
  disabled = false,
  searchable = options.length >= SEARCH_FROM,
}: {
  label: string;
  hint?: string;
  value: string;
  options: FieldOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** A search at the list's top; on its own from SEARCH_FROM options on. */
  searchable?: boolean;
}) {
  const id = useId();
  const chosen = options.find((option) => option.value === value);

  return (
    <Labelled label={label} {...(hint ? { hint } : {})} id={id}>
      <Choice
        label={label}
        value={value}
        options={options}
        onValueChange={onValueChange}
        disabled={disabled}
        searchable={searchable}
        triggerClass={trigger}
        width="w-(--anchor-width)"
        shown={<Shown placeholder={placeholder} {...(chosen ? { option: chosen } : {})} />}
        triggerProps={{ id, 'aria-describedby': hint ? `${id}-hint` : undefined }}
      />
    </Labelled>
  );
}

/**
 * Several choices that take a form's whole row: the first ones chosen sit in the field as chips,
 * the rest as a count, so it stays one line tall however many there are. Anywhere but a chip's
 * remove opens a list as wide as the field, with a search at its top, that stays open to pick
 * more.
 */
export function MultiSelectField({
  label,
  hint,
  values,
  options,
  onValuesChange,
  placeholder = 'Choose',
}: {
  label: string;
  hint?: string;
  values: string[];
  options: FieldOption[];
  onValuesChange: (values: string[]) => void;
  /** What the empty field says, before anything is chosen. */
  placeholder?: string;
}) {
  const id = useId();
  const field = useRef<HTMLDivElement>(null);
  const chosen = options.filter((option) => values.includes(option.value));
  const rest = chosen.length - CHIPS_SHOWN;

  return (
    <Labelled label={label} {...(hint ? { hint } : {})} id={id}>
      <Combobox.Root
        multiple
        items={options}
        value={chosen}
        onValueChange={(next: FieldOption[]) => onValuesChange(next.map((option) => option.value))}
        isItemEqualToValue={(a: FieldOption, b: FieldOption) => a.value === b.value}
        filter={matches}
      >
        {/* The trigger covers the whole field, under the chips; only their remove buttons take
            a click of their own. */}
        <div
          ref={field}
          className={`${control} relative flex h-10 items-center pr-9 pl-1.5 has-focus-visible:border-ink/25 has-data-popup-open:border-ink/25 has-data-popup-open:bg-glass-press`}
        >
          <Combobox.Trigger
            id={id}
            aria-describedby={hint ? `${id}-hint` : undefined}
            className="absolute inset-0 flex cursor-pointer items-center justify-end rounded-xl pr-3 outline-none"
          >
            <ChevronDown size={15} aria-hidden="true" className="shrink-0 text-muted" />
          </Combobox.Trigger>
          <Combobox.Chips className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {!chosen.length && (
              <span className="truncate px-2 text-sm text-muted/70">{placeholder}</span>
            )}
            {chosen.slice(0, CHIPS_SHOWN).map((option) => (
              <Combobox.Chip
                key={option.value}
                aria-label={option.label}
                className="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-lg bg-glass-press pr-1 pl-2 text-[13px] text-ink outline-none data-highlighted:bg-ink/15"
              >
                {option.icon && (
                  <span className="grid size-4 shrink-0 place-items-center text-muted">
                    {option.icon}
                  </span>
                )}
                <span className="min-w-0 truncate">{option.label}</span>
                <Combobox.ChipRemove
                  aria-label={`Remove ${option.label}`}
                  className="pointer-events-auto grid size-5 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-glass-hover hover:text-ink"
                >
                  <X size={12} aria-hidden="true" />
                </Combobox.ChipRemove>
              </Combobox.Chip>
            ))}
            {rest > 0 && (
              <span className="shrink-0 px-1 text-xs whitespace-nowrap text-muted">
                +{rest} more
              </span>
            )}
          </Combobox.Chips>
        </div>
        <Combobox.Portal>
          <Combobox.Positioner
            anchor={field}
            side="bottom"
            align="start"
            sideOffset={6}
            className={`${positioner} w-(--anchor-width)`}
          >
            <Combobox.Popup aria-label={label} className={`${popup} grid-rows-[auto_1fr]`}>
              <div className="flex h-10 items-center gap-2 border-b border-glass-edge px-3 text-muted">
                <Search size={14} aria-hidden="true" />
                <Combobox.Input
                  aria-label={`Search ${label.toLowerCase()}`}
                  placeholder="Search"
                  className={`${bareInput} text-[13px]`}
                />
              </div>
              <Matches />
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </Labelled>
  );
}

/**
 * A choice made from a small outline button, where a row or a card offers one beside other
 * things: what it says is the action, and picking an option is doing it. Its list is wider than
 * the button, searchable once long.
 */
export function SelectButton({
  label,
  value = '',
  options,
  onValueChange,
  disabled = false,
  children,
}: {
  /** What the button does, for assistive technology and the list's search. */
  label: string;
  value?: string;
  options: FieldOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  /** What the button says. */
  children: ReactNode;
}) {
  return (
    <Choice
      label={label}
      value={value}
      options={options}
      onValueChange={onValueChange}
      disabled={disabled}
      searchable={options.length >= SEARCH_FROM}
      triggerClass={buttonTrigger}
      width="w-[min(20rem,calc(100vw-2rem))]"
      shown={
        <>
          {children}
          <ChevronDown size={13} aria-hidden="true" className="shrink-0 text-muted" />
        </>
      }
      triggerProps={{ 'aria-label': label }}
    />
  );
}

/**
 * A choice that narrows a list, beside its search: as tall as the search box and drawn like it,
 * showing what is chosen. Its list is as wide as it needs, not as the trigger.
 */
export function FilterSelect({
  label,
  value,
  options,
  onValueChange,
  disabled = false,
}: {
  /** What it filters by, for assistive technology. */
  label: string;
  value: string;
  options: FieldOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  const chosen = options.find((option) => option.value === value);

  return (
    <Choice
      label={label}
      value={value}
      options={options}
      onValueChange={onValueChange}
      disabled={disabled}
      searchable={options.length >= SEARCH_FROM}
      triggerClass={`${searchBox} shrink-0 text-[13px] text-ink transition-colors hover:bg-glass-press data-popup-open:border-ink/20 data-popup-open:bg-glass-press disabled:opacity-45`}
      width="min-w-(--anchor-width) w-max max-w-[min(20rem,calc(100vw-2rem))]"
      shown={
        <>
          <span className="truncate">{chosen?.label ?? label}</span>
          <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-muted" />
        </>
      }
      triggerProps={{ 'aria-label': label }}
    />
  );
}
