'use client';

import { Combobox } from '@base-ui/react/combobox';
import { Select as BaseSelect } from '@base-ui/react/select';
import { Check, ChevronDown, Search } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';

export type SelectOption = {
  value: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  disabled?: boolean;
};
type Props = {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  placeholder?: string;
  searchThreshold?: number;
  className?: string;
  footer?: (close: () => void) => ReactNode;
  renderValue?: (option: SelectOption | undefined) => ReactNode;
};

function OptionContent({ option }: { option: SelectOption }) {
  return (
    <>
      {option.icon}
      <span className="select-option-copy">
        <span>{option.label}</span>
        {option.detail && <small>{option.detail}</small>}
      </span>
    </>
  );
}

/** Both modes share a trigger; long lists add filtering without changing the field API. */
/** Case and accents are not what anyone searches by. */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

/**
 * Every word typed must appear in the option's name or in the line under it, so an option can
 * be found by what it says as well as by what it is called.
 */
function matches(option: SelectOption, query: string) {
  const haystack = fold(`${option.label} ${option.detail ?? ''}`);

  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export function Select({
  value,
  onValueChange,
  options,
  disabled,
  id,
  placeholder = 'Select',
  searchThreshold = 8,
  className = '',
  footer,
  renderValue,
  ...aria
}: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const content = (
    <>
      <span className="select-value">
        {renderValue ? (
          renderValue(selected)
        ) : selected ? (
          <OptionContent option={selected} />
        ) : (
          placeholder
        )}
      </span>
      <ChevronDown size={15} className="select-chevron" />
    </>
  );
  const changeOpen = (next: boolean) => {
    // Inside a native dialog or the mobile sidebar, so focus and Escape stay in their
    // boundary — and positioned `fixed`, because an absolute popup in a box that scrolls
    // grows that box and reflows the form underneath it.
    if (next) setContainer(trigger.current?.closest<HTMLElement>('dialog, aside') ?? null);
    setOpen(next);
  };
  const triggerProps = {
    ref: trigger,
    id,
    disabled,
    ...aria,
    className: `select-trigger ${className}`,
  };
  const footerContent = footer && (
    <div className="select-footer">{footer(() => setOpen(false))}</div>
  );

  if (options.length >= searchThreshold) {
    return (
      <Combobox.Root
        items={options}
        value={selected ?? null}
        onValueChange={(option) => {
          if (option) onValueChange(option.value);
        }}
        open={open}
        onOpenChange={changeOpen}
        disabled={disabled}
        filter={(option: SelectOption, query: string) => matches(option, query)}
      >
        <Combobox.Trigger {...triggerProps}>{content}</Combobox.Trigger>
        <Combobox.Portal container={container ?? undefined}>
          <Combobox.Positioner
            className="select-positioner"
            sideOffset={6}
            align="start"
            positionMethod="fixed"
          >
            <Combobox.Popup className="select-popup" aria-label={aria['aria-label'] ?? 'Options'}>
              <div className="select-search">
                <Search size={15} />
                <Combobox.Input aria-label="Search options" placeholder="Search…" />
              </div>
              <Combobox.Empty className="select-empty">No result.</Combobox.Empty>
              <Combobox.List className="select-list">
                {(option: SelectOption) => (
                  <Combobox.Item
                    className="select-option"
                    key={option.value}
                    value={option}
                    disabled={option.disabled}
                  >
                    <OptionContent option={option} />
                    <Combobox.ItemIndicator className="select-check">
                      <Check size={15} />
                    </Combobox.ItemIndicator>
                  </Combobox.Item>
                )}
              </Combobox.List>
              {footerContent}
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    );
  }
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      open={open}
      onOpenChange={changeOpen}
      disabled={disabled}
      items={options}
    >
      <BaseSelect.Trigger {...triggerProps}>{content}</BaseSelect.Trigger>
      <BaseSelect.Portal container={container ?? undefined}>
        <BaseSelect.Positioner
          className="select-positioner"
          sideOffset={6}
          align="start"
          alignItemWithTrigger={false}
          positionMethod="fixed"
        >
          <BaseSelect.Popup className="select-popup">
            <BaseSelect.List className="select-list">
              {options.map((option) => (
                <BaseSelect.Item
                  className="select-option"
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                >
                  <OptionContent option={option} />
                  <BaseSelect.ItemIndicator className="select-check">
                    <Check size={15} />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
            {footerContent}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
