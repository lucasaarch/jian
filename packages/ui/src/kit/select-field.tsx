'use client';

import { Combobox } from '@base-ui/react/combobox';
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown, Search } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { matchesQuery } from '../lib/search';
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
        filter={(option: FieldOption, query: string) =>
          matchesQuery(`${option.label} ${option.detail ?? ''}`, query)
        }
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
