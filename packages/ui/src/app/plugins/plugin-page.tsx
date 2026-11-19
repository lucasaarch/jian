'use client';

import { Menu } from '@base-ui/react/menu';
import { Ellipsis } from 'lucide-react';
import type { ReactNode } from 'react';
import { Action, iconButton, menuPopup } from '../../kit';
import { VerifiedBadge } from './plugin-list';

/**
 * The head of a plugin's own page, a skill's or a connector's: its mark in a tile, its name with
 * Jian's badge on what Jian provides, and under it whose it is and what it is for, on one line.
 * What acts on it stands at the right, each in the toolbar's one box, 2rem tall, and drops under
 * the name where the two cannot share a line. `titleId` names the page by its heading.
 */
export function PluginHeader({
  titleId,
  icon,
  name,
  verified,
  subline,
  children,
}: {
  titleId: string;
  icon: ReactNode;
  name: string;
  verified: boolean;
  subline: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3">
      <span
        aria-hidden="true"
        className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-glass-edge bg-ink/5 text-ink"
      >
        {icon}
      </span>
      <div className="grid min-w-0 flex-1 basis-48 grid-cols-1 gap-0.5">
        <h1
          id={titleId}
          className="flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight text-ink"
        >
          <span className="min-w-0 truncate">{name}</span>
          {verified && <VerifiedBadge />}
        </h1>
        <p className="truncate text-sm text-muted">{subline}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </header>
  );
}

/** What is done to a plugin less often, behind one button at the end of its header. */
export function MoreMenu({ children }: { children: ReactNode }) {
  return (
    <Menu.Root>
      {/* The bar's round button, in a box as tall as its neighbours so the row stays one line. */}
      <span className="grid size-8 place-items-center">
        <Menu.Trigger aria-label="More" className={iconButton}>
          <Ellipsis size={16} aria-hidden="true" />
        </Menu.Trigger>
      </span>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={`${menuPopup} min-w-48`}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** While a plugin is edited in its page: leave it as it was, or keep what the form says. */
export function PluginEditActions({
  form,
  busy,
  onCancel,
}: {
  /** The id of the form Save sends, which is drawn below the header. */
  form: string;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <>
      <Action tone="quiet" size="field" onClick={onCancel}>
        Cancel
      </Action>
      <Action tone="primary" size="field" type="submit" form={form} busy={busy}>
        Save
      </Action>
    </>
  );
}

/**
 * What the plugin says on the left and what is known about it in a column on the right, which
 * drops under it where the page is narrow: measured on an `@container` around this grid, since
 * the sidebar takes its share of the window.
 */
export const pluginColumns =
  'grid grid-cols-[minmax(0,1fr)_15rem] items-start gap-x-12 gap-y-8 @max-[44rem]:grid-cols-1';

/** The column of what is known about a plugin: one under the other, and two abreast under it. */
export function PluginDetails({ children }: { children: ReactNode }) {
  return (
    <dl
      aria-label="Details"
      className="grid grid-cols-1 content-start gap-x-8 gap-y-5 @max-[44rem]:grid-cols-2 @max-[26rem]:grid-cols-1"
    >
      {children}
    </dl>
  );
}

/** One thing known about a plugin, under its quiet label. */
export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-1 content-start gap-1">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ink">
        {children}
      </dd>
    </div>
  );
}
