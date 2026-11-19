'use client';

import {
  PANEL_USAGE_COUNT_MAX,
  type PanelFeature,
  type PanelUsage,
  panelFeatureOf,
} from '@jian/contracts';
import { useEffect } from 'react';
import { gatewayConnection } from '../platform/gateway';
import { GatewayAnswer } from './api/result';
import { onPhone } from './phone';
import { panelApi } from './query/client';

/**
 * What the panel counts of its own use, for its gateway's anonymous daily report: how often each
 * key of the vocabulary in contracts happened, and nothing else. Counts are kept in memory and
 * handed over in batches (app/panel-usage.ts); no script of anyone else's runs in the panel.
 *
 * Until the gateway says whether its report is on, counts wait here, so the first screens of a
 * visit are not lost; once it says off, nothing is counted and what waited is dropped.
 */
let reporting: 'unknown' | 'on' | 'off' = 'unknown';

/** By the width the panel was drawn at when each was counted, since a report names one. */
const counted = { wide: new Map<PanelFeature, number>(), phone: new Map<PanelFeature, number>() };

const add = (into: Map<PanelFeature, number>, feature: PanelFeature, by: number) =>
  into.set(feature, Math.min((into.get(feature) ?? 0) + by, PANEL_USAGE_COUNT_MAX));

const atPhoneWidth = () => {
  try {
    return onPhone();
  } catch {
    // A window with no media queries is no phone.
    return false;
  }
};

/**
 * Counts one use. A key the vocabulary does not have is ignored: the gateway would refuse the
 * whole report for it.
 */
export function countUsage(feature: PanelFeature | undefined) {
  if (!feature || reporting === 'off' || !panelFeatureOf(feature)) return;
  add(atPhoneWidth() ? counted.phone : counted.wide, feature, 1);
}

/** Counts `feature` as it is drawn, and again whenever it, or `key`, changes. */
export function useUsage(feature: PanelFeature | undefined, key?: string) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is what makes it count again.
  useEffect(() => countUsage(feature), [feature, key]);
}

/** Whether the gateway keeps the counts, from its settings; undefined while it has not said. */
export function setUsageReporting(on: boolean | undefined) {
  reporting = on === undefined ? 'unknown' : on ? 'on' : 'off';
  if (reporting === 'off') {
    counted.wide.clear();
    counted.phone.clear();
  }
}

/**
 * Hands what was counted to the gateway, one report by width, and starts counting from nothing.
 * A report that never reached it is counted again for the next; one it answered and refused is
 * dropped, since the same report would be refused again.
 */
export async function flushUsage(
  send: (usage: PanelUsage) => Promise<unknown> = (usage) => panelApi().reportPanelUsage(usage),
) {
  if (reporting !== 'on') return;
  const host = gatewayConnection().host ?? 'web';
  await Promise.all(
    (['wide', 'phone'] as const).map(async (width) => {
      const bucket = counted[width];
      if (!bucket.size) return;
      const counts = Object.fromEntries(bucket) as PanelUsage['counts'];
      bucket.clear();
      try {
        await send({ host, phone: width === 'phone', counts });
      } catch (error) {
        if ((error instanceof GatewayAnswer && error.status) || reporting === 'off') return;
        for (const [feature, n] of Object.entries(counts)) add(bucket, feature as PanelFeature, n);
      }
    }),
  );
}
