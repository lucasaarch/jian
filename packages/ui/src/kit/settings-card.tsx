import type { ReactNode } from 'react';

/**
 * Cards side by side on a settings page, two to a line and one on a phone. The columns are
 * `minmax(0, 1fr)`, so a long name is cut short in its card instead of widening the page.
 */
export function SettingsCards({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">{children}</div>;
}

/**
 * One thing to connect, as a card: its mark and name with its state beside them, a line on what
 * it gives, and its action at the foot. Cards in a line take the tallest one's height, so the
 * action stays at the bottom whatever the description's length.
 */
export function SettingsCard({
  icon,
  title,
  status,
  description,
  action,
}: {
  icon: ReactNode;
  title: ReactNode;
  /** Pills after the name, such as Connected or Needs attention. */
  status?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border border-glass-edge bg-glass-hover p-4">
      <header className="flex min-w-0 flex-wrap items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-glass-edge bg-ink/5 text-ink"
        >
          {icon}
        </span>
        <h3 className="min-w-0 truncate text-[13px] font-medium text-ink">{title}</h3>
        {status}
      </header>
      {description && <p className="text-xs leading-snug text-muted">{description}</p>}
      {action && <div className="mt-auto flex items-center gap-2">{action}</div>}
    </article>
  );
}
