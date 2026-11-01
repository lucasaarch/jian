'use client';

import { Popover } from '@base-ui/react/popover';
import { useQuery } from '@tanstack/react-query';
import { ProviderLogo } from '../../components/ui';
import type { SubscriptionUsage } from '../../lib/api';
import { LOCALE } from '../../lib/format';
import { queries } from '../../lib/query/profile';
import { statusItem } from './status-item';

type Window = NonNullable<SubscriptionUsage['fiveHour']>;

/** Past this share a window is close to running out; past the second, it as good as has. */
const NEAR = 80;
const OUT = 95;

const ink = (used: number) => (used >= OUT ? 'text-bad' : used >= NEAR ? 'text-warn' : 'text-ink');
const fill = (used: number) => (used >= OUT ? 'bg-bad' : used >= NEAR ? 'bg-warn' : 'bg-ink/70');

const nameOf = (subscription: SubscriptionUsage) =>
  subscription.provider === 'codex' ? 'Codex' : 'Claude';

/** What a subscription reports: Codex its weekly window alone, Claude a five-hour one beside it. */
function windowsOf(subscription: SubscriptionUsage): { label: string; window: Window }[] {
  if (subscription.status !== 'available') return [];
  return [
    ...(subscription.provider !== 'codex' && subscription.fiveHour
      ? [{ label: '5-hour window', window: subscription.fiveHour }]
      : []),
    ...(subscription.weekly ? [{ label: 'Weekly window', window: subscription.weekly }] : []),
  ];
}

function Bar({ used, className }: { used: number; className: string }) {
  return (
    <span className={`relative block overflow-hidden rounded-full bg-ink/12 ${className}`}>
      <span
        className={`absolute inset-y-0 left-0 rounded-full ${fill(used)}`}
        style={{ width: `${Math.min(100, used)}%` }}
      />
    </span>
  );
}

/** One subscription in the bar: its mark and the window closest to running out. */
function Glance({ subscription }: { subscription: SubscriptionUsage }) {
  const used = Math.max(...windowsOf(subscription).map(({ window }) => window.usedPercent));
  return (
    <span className="flex items-center gap-1.5">
      <ProviderLogo kind={subscription.provider === 'codex' ? 'openai' : 'anthropic'} size={12} />
      <Bar used={used} className="h-1 w-5" />
      <span className={`tabular-nums ${ink(used)}`}>{used.toFixed(0)}%</span>
    </span>
  );
}

function Details({ subscription }: { subscription: SubscriptionUsage }) {
  const windows = windowsOf(subscription);
  return (
    <section className="grid gap-2.5">
      <h3 className="m-0 flex items-center gap-2 text-[13px] font-medium">
        <ProviderLogo kind={subscription.provider === 'codex' ? 'openai' : 'anthropic'} size={14} />
        {nameOf(subscription)}
      </h3>
      {windows.map(({ label, window }) => (
        <div key={label} className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
            {label}
            <span className={`font-medium tabular-nums ${ink(window.usedPercent)}`}>
              {window.usedPercent.toFixed(0)}% used
            </span>
          </div>
          <Bar used={window.usedPercent} className="h-1.5 w-full" />
          {window.resetsAt && (
            <p className="m-0 text-xs text-muted">
              Resets{' '}
              {new Date(window.resetsAt).toLocaleString(LOCALE, {
                weekday: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * How much of the Claude and Codex subscriptions is used, in the status bar: for each, the window
 * closest to running out, amber as it nears the end and red at it. It opens a popover with each
 * window and when it resets. A subscription that has said nothing yet is left out: Claude's limits
 * come only with its answers, so it appears after a run on it.
 */
export function SubscriptionMeter() {
  const usage = (useQuery(queries.subscriptionUsage()).data ?? []).filter(
    (subscription) => windowsOf(subscription).length > 0,
  );
  if (!usage.length) return null;

  return (
    <Popover.Root>
      <Popover.Trigger className={`${statusItem} gap-2.5`} aria-label="Subscription limits">
        {usage.map((subscription) => (
          <Glance key={subscription.provider} subscription={subscription} />
        ))}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} className="z-50">
          <Popover.Popup className="glass grid w-72 origin-(--transform-origin) gap-4 rounded-2xl p-4 text-[13px] text-ink outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <header className="grid gap-0.5">
              <Popover.Title className="m-0 text-sm font-semibold">
                Subscription limits
              </Popover.Title>
              <p className="m-0 text-xs leading-relaxed text-muted">
                Shared by every agent on this gateway. A window used up stops that subscription
                until it resets.
              </p>
            </header>
            {usage.map((subscription) => (
              <Details key={subscription.provider} subscription={subscription} />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
