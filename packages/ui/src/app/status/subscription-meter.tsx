'use client';

import { useQuery } from '@tanstack/react-query';
import { ProviderLogo } from '../../components/ui';
import type { SubscriptionUsage } from '../../lib/api';
import { LOCALE } from '../../lib/format';
import { agentPath } from '../../lib/navigation';
import { queries } from '../../lib/query/profile';
import { useProfileId } from '../../lib/workspace';
import { useRouter } from '../../platform/navigation';
import { statusItem } from './status-item';

type Window = NonNullable<SubscriptionUsage['fiveHour']>;

/** Past this share a window is close to running out; past the second, it as good as has. */
const NEAR = 80;
const OUT = 95;

const ink = (used: number) => (used >= OUT ? 'text-bad' : used >= NEAR ? 'text-warn' : 'text-ink');
const fill = (used: number) => (used >= OUT ? 'bg-bad' : used >= NEAR ? 'bg-warn' : 'bg-ink/70');

/** When a window starts afresh, as a line of the tooltip. */
const resets = (label: string, window: Window) =>
  `${label}: ${window.usedPercent.toFixed(0)}% used${
    window.resetsAt
      ? `, resets ${new Date(window.resetsAt).toLocaleString(LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : ''
  }`;

/**
 * How much of the Claude and Codex subscriptions is used, in the status bar: each window's
 * share with a small bar, amber as it nears the end and red at it, the resets in its tooltip.
 * It opens the Overview, where they are told in full. Nothing shows without a subscription.
 */
export function SubscriptionMeter() {
  const profileId = useProfileId();
  const router = useRouter();
  const usage = useQuery(queries.subscriptionUsage()).data ?? [];
  const shown = usage.filter(
    (subscription) =>
      subscription.status === 'available' && (subscription.fiveHour || subscription.weekly),
  );
  if (!shown.length) return null;

  return (
    <div className="flex min-w-0 items-center">
      {shown.map((subscription) => {
        const codex = subscription.provider === 'codex';
        const name = codex ? 'Codex' : 'Claude';
        // Codex reports its weekly window alone; Claude, a five-hour one beside it.
        const windows: { short: string; label: string; window: Window }[] = [];
        if (!codex && subscription.fiveHour)
          windows.push({ short: '5h', label: '5-hour window', window: subscription.fiveHour });
        if (subscription.weekly)
          windows.push({ short: 'week', label: 'Weekly window', window: subscription.weekly });
        const title = [name, ...windows.map((entry) => resets(entry.label, entry.window))].join(
          '\n',
        );
        return (
          <button
            key={subscription.provider}
            type="button"
            className={statusItem}
            title={title}
            aria-label={title.replaceAll('\n', '. ')}
            onClick={() => profileId && router.push(agentPath(profileId))}
          >
            <ProviderLogo kind={codex ? 'openai' : 'anthropic'} size={12} />
            {windows.map(({ short, window }) => (
              <span key={short} className="flex items-center gap-1">
                <span>{short}</span>
                <span className="relative h-1 w-5 overflow-hidden rounded-full bg-ink/12">
                  <span
                    className={`absolute inset-y-0 left-0 rounded-full ${fill(window.usedPercent)}`}
                    style={{ width: `${Math.min(100, window.usedPercent)}%` }}
                  />
                </span>
                <span className={`tabular-nums ${ink(window.usedPercent)}`}>
                  {window.usedPercent.toFixed(0)}%
                </span>
              </span>
            ))}
          </button>
        );
      })}
    </div>
  );
}
