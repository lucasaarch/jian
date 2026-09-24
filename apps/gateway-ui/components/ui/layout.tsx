import type { ReactNode } from 'react';
import { Mark } from './mark';

/** The title of a section, with the one action that creates what the section lists. */
export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Nothing to list yet: say what would be here and offer the step that creates it. */
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-orbit" aria-hidden="true">
        <Mark small />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  dot = true,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
  /** The dot marks a state; a badge that only counts something has none. */
  dot?: boolean;
}) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}
