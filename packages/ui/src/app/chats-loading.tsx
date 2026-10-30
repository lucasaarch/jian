'use client';

import { Mark } from '../components/ui';
import { Skeleton } from '../kit';

/** Widths of the stand-in rows, uneven as real titles are. */
const rows = [
  ['w-24', 'w-36', 'w-28'],
  ['w-32', 'w-20', 'w-40', 'w-24'],
];

/** The sidebar's sections while they load: their shape, breathing, where they will be. */
export function SidebarSkeleton() {
  return (
    <div className="flex flex-col gap-5 px-4 pt-1" aria-hidden="true">
      {rows.map((section, index) => (
        <div key={section.join()} className="flex flex-col gap-3.5">
          <Skeleton className={`h-2 rounded-full bg-ink/10 ${index ? 'w-20' : 'w-14'}`} />
          {section.map((width) => (
            <Skeleton key={width} className={`h-2.5 rounded-full bg-ink/7 ${width}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The conversation's place while the chats load: the mark breathing, and what it waits for. */
export function ChatsLoading({ label = 'Loading chats' }: { label?: string }) {
  return (
    <main className="grid h-full place-items-center" aria-busy="true" aria-label={label}>
      <div className="flex flex-col items-center gap-4">
        <span className="size-11 animate-pulse text-ink/80 [&_svg]:size-full">
          <Mark />
        </span>
        <p className="text-xs text-muted">{label}…</p>
      </div>
    </main>
  );
}
