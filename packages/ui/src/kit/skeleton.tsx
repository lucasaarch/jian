import type { ReactNode } from 'react';

/**
 * The shape of something still on its way, in the ink's quietest tint, so a page keeps its
 * layout while it reads and nothing moves when the content lands. Sized by `className`; the
 * pulse stops when motion is reduced. Hidden from assistive technology: the page around it says
 * that it is loading, once, rather than every block saying nothing.
 *
 * Its corners and tint are defaults that step aside when `className` names its own: two classes
 * for one property are settled by their order in the stylesheet, not in the attribute, so a
 * `rounded-full` beside the default `rounded-md` could lose.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  const corners = /(^|\s)rounded(-|\s|$)/.test(className) ? '' : 'rounded-md';
  const tint = /(^|\s)bg-/.test(className) ? '' : 'bg-ink/8';

  return (
    <span
      aria-hidden="true"
      className={`block motion-safe:animate-pulse ${corners} ${tint} ${className}`}
    />
  );
}

/**
 * A line of words still on its way: a bar about as tall as the text's letters, in a box one line
 * of the surrounding text tall (`1lh`), so it takes the line's height and the words that replace
 * it land on the same line. Its width comes from `className`.
 */
export function SkeletonLine({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden="true" className="flex h-[1lh] items-center">
      <Skeleton className={`h-[0.75em] ${className}`} />
    </span>
  );
}

/**
 * A region drawn in skeletons while it is read: marked busy, with one quiet sentence for a
 * screen reader. The sentence sits outside the busy region, whose words a reader holds back
 * until it is done. `className` lays out what it holds as the page it stands for would.
 */
export function SkeletonRegion({
  label,
  className = '',
  children,
}: {
  /** What is loading, said as a status: "Loading schedules…". */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <>
      <p role="status" className="sr-only">
        {label}
      </p>
      <div aria-busy="true" className={className}>
        {children}
      </div>
    </>
  );
}
