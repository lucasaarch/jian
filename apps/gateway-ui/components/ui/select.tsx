'use client';

import { Combobox } from '@base-ui/react/combobox';
import { Select as BaseSelect } from '@base-ui/react/select';
import { Check, ChevronDown, Search } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { matchesQuery } from '@/lib/search';

export type SelectOption = {
  value: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  /** A short state at the far end of the row, such as a repository's visibility. */
  badge?: ReactNode;
  disabled?: boolean;
};

/**
 * How the trigger looks where it stands. `default` is a form field. `ghost` is borderless and
 * compact, among the composer's tools. `subtle` has a lighter border over a translucent fill,
 * for the sidebar.
 */
type SelectVariant = 'default' | 'ghost' | 'subtle';

type CommonProps = {
  options: SelectOption[];
  variant?: SelectVariant;
  /**
   * `anchor` is as wide as the trigger; `content` is as wide as its longest option, for a small
   * trigger whose options carry long names, never narrower than the trigger nor wider than the
   * screen.
   */
  popup?: 'anchor' | 'content';
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  placeholder?: string;
  searchThreshold?: number;
  footer?: (close: () => void) => ReactNode;
};

type SingleProps = CommonProps & {
  multiple?: false;
  value: string;
  onValueChange: (value: string) => void;
  renderValue?: (option: SelectOption | undefined) => ReactNode;
};

type MultipleProps = CommonProps & {
  multiple: true;
  value: string[];
  onValueChange: (value: string[]) => void;
  renderValue?: (options: SelectOption[]) => ReactNode;
};

type Props = SingleProps | MultipleProps;

function OptionContent({ option }: { option: SelectOption }) {
  return (
    <>
      {option.icon}
      <span className="select-option-copy">
        <span>{option.label}</span>
        {option.detail && <small>{option.detail}</small>}
      </span>
      {option.badge}
    </>
  );
}

/** An option is found by its name or by the line under it. */
const matches = (option: SelectOption, query: string) =>
  matchesQuery(`${option.label} ${option.detail ?? ''}`, query);

function defaultMultipleValue(selected: SelectOption[]) {
  if (selected.length === 0) return null;

  return (
    <>
      {selected.some((option) => option.icon) ? (
        <span className="select-value-stack" aria-hidden="true">
          {selected.slice(0, 4).map((option) => (
            <span key={option.value} className="select-value-stack-item">
              {option.icon}
            </span>
          ))}
        </span>
      ) : null}
      <span className="select-option-copy">
        <span>
          {selected.length === 1
            ? selected[0]?.label
            : selected.length <= 3
              ? selected.map((option) => option.label).join(', ')
              : `${selected.length} agents`}
        </span>
      </span>
    </>
  );
}

export function Select(props: Props) {
  const {
    options,
    disabled,
    id,
    placeholder = 'Select',
    searchThreshold = 8,
    variant = 'default',
    popup = 'anchor',
    footer,
    renderValue,
  } = props;
  const aria = {
    'aria-label': props['aria-label'],
    'aria-describedby': props['aria-describedby'],
  };
  const multiple = props.multiple === true;
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const selectedOptions = multiple
    ? options.filter((option) => props.value.includes(option.value))
    : [];
  const selected = multiple ? undefined : options.find((option) => option.value === props.value);
  let valueNode: ReactNode = placeholder;
  if (multiple) {
    valueNode =
      (renderValue as MultipleProps['renderValue'])?.(selectedOptions) ??
      defaultMultipleValue(selectedOptions) ??
      placeholder;
  } else if (renderValue) {
    valueNode = (renderValue as SingleProps['renderValue'])?.(selected);
  } else if (selected) {
    valueNode = <OptionContent option={selected} />;
  }
  const content = (
    <>
      <span className="select-value">{valueNode}</span>
      <ChevronDown size={15} className="select-chevron" />
    </>
  );
  const changeOpen = (next: boolean) => {
    // Portal into the dialog/aside (not document.body): a modal dialog's top layer would
    // hide a body portal. The dialog itself must not use overflow:hidden, or this popup
    // is clipped — scrolling stays on .modal-body. Position fixed so a scrolling body
    // does not grow when the list opens.
    if (next) setContainer(trigger.current?.closest<HTMLElement>('dialog, aside') ?? null);
    setOpen(next);
  };
  const triggerProps = {
    ref: trigger,
    id,
    disabled,
    ...aria,
    className: `select-trigger ${variant}`,
  };
  const footerContent = footer && (
    <div className="select-footer">{footer(() => setOpen(false))}</div>
  );

  if (options.length >= searchThreshold) {
    if (multiple) {
      return (
        <Combobox.Root
          multiple
          items={options}
          value={selectedOptions}
          onValueChange={(next) => {
            props.onValueChange((next ?? []).map((option) => option.value));
          }}
          isItemEqualToValue={(a, b) => a.value === b.value}
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
              // Viewport only: clipping-ancestors would cap height to the dialog and clip
              // the list under the footer even when the dialog itself does not overflow:hidden.
              collisionBoundary={[]}
            >
              <Combobox.Popup
                className={`select-popup ${popup}`}
                aria-label={aria['aria-label'] ?? 'Options'}
              >
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
      <Combobox.Root
        items={options}
        value={selected ?? null}
        onValueChange={(option) => {
          if (option) props.onValueChange(option.value);
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
            collisionBoundary={[]}
          >
            <Combobox.Popup
              className={`select-popup ${popup}`}
              aria-label={aria['aria-label'] ?? 'Options'}
            >
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

  if (multiple) {
    return (
      <BaseSelect.Root
        multiple
        value={props.value}
        onValueChange={(next) => {
          props.onValueChange(next ?? []);
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
            collisionBoundary={[]}
          >
            <BaseSelect.Popup className={`select-popup ${popup}`}>
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

  return (
    <BaseSelect.Root
      value={props.value}
      onValueChange={(next) => {
        if (next !== null) props.onValueChange(next);
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
          collisionBoundary={[]}
        >
          <BaseSelect.Popup className={`select-popup ${popup}`}>
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
