import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';

/**
 * One thing the installation or a profile holds, as Channels, Providers, Skills and MCP list
 * them: what it is, its state in badges, the facts that matter, and its details and actions
 * opening under the whole row.
 */
export function ResourceRow({
  id,
  icon,
  name,
  badges,
  description,
  facts = [],
  action = 'Manage',
  open = false,
  onToggle,
  actions,
  busy,
  extra,
  children,
}: {
  id: string;
  icon: ReactNode;
  name: string;
  badges?: ReactNode;
  description: string;
  facts?: string[];
  action?: string;
  open?: boolean;
  /** Present when the row opens; a row whose actions fit on it passes `actions` instead. */
  onToggle?: () => void;
  actions?: ReactNode;
  busy?: boolean;
  /** Shown under the facts, for what a row holds besides text, such as links to others. */
  extra?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className="resource-row items-start expandable-row" data-open={open}>
      <div className="resource-icon tile" aria-hidden="true">
        {icon}
      </div>
      <div className="grow">
        <h3>
          {name}
          {badges}
        </h3>
        <p>{description}</p>
        {facts.length > 0 && (
          <div className="row-facts">
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </div>
        )}
        {extra}
      </div>
      <div className="row-actions">
        {actions}
        {onToggle && (
          <Button
            type="button"
            variant="quiet"
            disabled={busy}
            aria-expanded={open}
            aria-controls={id}
            onClick={onToggle}
          >
            {open ? 'Close' : action}
            <ChevronDown size={16} className={open ? 'rotate-180' : undefined} />
          </Button>
        )}
      </div>
      {onToggle && (
        <div id={id} className="connection-disclosure basis-full" hidden={!open}>
          {open && children}
        </div>
      )}
    </article>
  );
}
