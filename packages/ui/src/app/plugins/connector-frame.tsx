'use client';

import type { ReactNode } from 'react';
import { BackLink } from '../../kit';
import { LOCALE } from '../../lib/format';
import { ConnectorIcon } from './connector-icon';
import { type Connector, connectorMeta, isVerified } from './connectors';
import { VerifiedBadge } from './plugin-list';
import { Detail, PluginDetails, PluginHeader, pluginColumns } from './plugin-page';

const month = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });

/** Since when a connector has had an account, from the oldest of them; nothing with none. */
export function since(dates: string[]): string | undefined {
  const first = dates.map(Date.parse).sort((a, b) => a - b)[0];
  return first === undefined ? undefined : month.format(first);
}

/** A column of reading and of fields: lines short enough to follow, whatever the page's width. */
export const reading = 'max-w-[44rem]';

/** A sentence about a section, under it, in the quiet ground a note has anywhere in the kit. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className={`rounded-lg bg-ink/5 px-3 py-2.5 text-xs leading-relaxed text-muted ${reading}`}>
      {children}
    </p>
  );
}

/**
 * A connector's page, whatever it is underneath, in the anatomy a skill's has: the way back to
 * Plugins, its mark and name with whose it is and what it gives, and what acts on it at the
 * right; under them what it holds (`children`: its accounts, its sign-in, its tools) beside a
 * column of what is known about it. `details` are that column's rows after who made it, in
 * order, and one with nothing to say is left out.
 */
export function ConnectorFrame({
  connector,
  back,
  lead,
  actions,
  details,
  children,
}: {
  connector: Connector;
  /** Goes back to Plugins, on the tab the connector was opened from. */
  back: () => void;
  /** What it gives, in a sentence or two, at the top of the page. */
  lead: ReactNode;
  actions?: ReactNode;
  details: [label: string, value: ReactNode][];
  children?: ReactNode;
}) {
  const verified = isVerified(connector);

  return (
    <>
      <div className="grid grid-cols-1 gap-3">
        <BackLink onClick={back}>Plugins</BackLink>
        <PluginHeader
          titleId="connector-title"
          icon={<ConnectorIcon connector={connector} large />}
          name={connector.name}
          verified={verified}
          subline={`${connectorMeta(connector)} · ${connector.description}`}
        >
          {actions}
        </PluginHeader>
      </div>
      <div className="@container">
        <div className={pluginColumns}>
          <div className="grid min-w-0 grid-cols-1 gap-6">
            <p className={`text-sm leading-relaxed text-ink ${reading}`}>{lead}</p>
            {children}
          </div>
          <PluginDetails>
            <Detail label="Made by">
              {verified ? 'Jian' : 'You'}
              {verified && <VerifiedBadge />}
            </Detail>
            {details.map(
              ([label, value]) =>
                Boolean(value) && (
                  <Detail key={label} label={label}>
                    <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
                  </Detail>
                ),
            )}
          </PluginDetails>
        </div>
      </div>
    </>
  );
}
