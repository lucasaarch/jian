import type { ReactNode } from 'react';

/**
 * Inputs that belong to one value, drawn as one control: a single border around the group and
 * a hairline between them, rather than two boxes that read as two unrelated questions.
 */
export function StackedFields({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="stacked-row">
      <div className="stacked-fields">{children}</div>
      {action}
    </div>
  );
}
