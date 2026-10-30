import type { ReactNode } from 'react';
import { SettingsRow } from './settings-layout';
import { Skeleton, SkeletonLine, SkeletonRegion } from './skeleton';

/** Uneven, as real names are: rows of one width read as a pattern, not as a list on its way. */
const widths = ['w-36', 'w-28', 'w-44', 'w-32', 'w-40', 'w-24'];

/**
 * A settings row still on its way, drawn by `SettingsRow` itself so it takes the same height
 * and padding: its name, a pill beside it where the real row has one, a line of description
 * where it has one, and what ends it at the size of the real thing: a switch, a model menu, up
 * to two small buttons.
 */
export function SettingsRowSkeleton({
  index = 0,
  pill = false,
  description = false,
  toggle = false,
  menu = false,
  buttons = 1,
}: {
  /** Its place in the list, which picks the width of its name. */
  index?: number;
  pill?: boolean;
  description?: boolean;
  toggle?: boolean;
  menu?: boolean;
  buttons?: 0 | 1 | 2;
}) {
  const end = toggle || menu || buttons > 0;

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <SkeletonLine className={widths[index % widths.length]} />
          {pill && <Skeleton className="h-5 w-14 rounded-full" />}
        </span>
      }
      description={description ? <SkeletonLine className="w-3/5" /> : undefined}
    >
      {end && (
        <>
          {toggle && <Skeleton className="h-5 w-8 rounded-full" />}
          {menu && <Skeleton className="h-8 w-36 rounded-lg" />}
          {buttons > 0 && <Skeleton className="h-7 w-20" />}
          {buttons > 1 && <Skeleton className="h-7 w-20" />}
        </>
      )}
    </SettingsRow>
  );
}

/** Several rows on their way, `count` of them, each with what `row` gives every one. */
export function SettingsRowsSkeleton({
  count,
  from = 0,
  ...row
}: Omit<Parameters<typeof SettingsRowSkeleton>[0], 'index'> & {
  count: number;
  /** Where the widths start, so a second run of rows does not repeat the first. */
  from?: number;
}) {
  return Array.from({ length: count }, (_, place) => from + place).map((index) => (
    <SettingsRowSkeleton key={index} index={index} {...row} />
  ));
}

/**
 * A settings page while it is read, under the title its layout already shows: the cards it will
 * hold, in skeleton rows, in the page's column and spaced as the page spaces them.
 */
export function SettingsPageSkeleton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SkeletonRegion label={label} className="grid grid-cols-1 gap-7 phone:gap-5">
      {children}
    </SkeletonRegion>
  );
}
