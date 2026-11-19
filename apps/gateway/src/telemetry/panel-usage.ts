import { PANEL_FEATURES, type PanelFeature, type PanelUsage } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { GATEWAY_SCOPE } from '../security/gateway-vault.js';
import type { Queryable, Store } from '../storage/database.js';
import { gatewaySettings } from '../storage/schema.js';

/**
 * What the panel counted of its own use since the last report was sent, as one JSON value of the
 * gateway's settings: a handful of keys by four surfaces, so a table of its own would hold no
 * more. Every change is made under the installation's lock, read and written in one transaction,
 * so two panels reporting at once, or a report sent meanwhile, never lose a count.
 */
const KEY = 'telemetryPanelUsage';

/** Where a count came from: the host, and whether the panel was drawn at a phone's width. */
const SURFACES = ['web', 'web_phone', 'desktop', 'desktop_phone'] as const;
type Surface = (typeof SURFACES)[number];
type Counts = Partial<Record<PanelFeature, number>>;
type Tally = Partial<Record<Surface, Counts>>;

/**
 * The most one key holds. A development build never reports, so nothing ever takes its counts
 * off; the ceiling keeps the value as small as the vocabulary however long it runs.
 */
const CEILING = 1_000_000_000;

const known = new Set<string>(PANEL_FEATURES);

/**
 * The kept value with nothing outside the vocabulary: a key a later release wrote, then rolled
 * back, or one written by hand, is never read, so it is never sent.
 */
function tallyOf(value: unknown): Tally {
  const tally: Tally = {};
  if (!value || typeof value !== 'object') return tally;
  for (const surface of SURFACES) {
    const counts: unknown = (value as Record<string, unknown>)[surface];
    if (!counts || typeof counts !== 'object') continue;
    for (const [key, n] of Object.entries(counts)) {
      if (!known.has(key) || !Number.isSafeInteger(n) || n <= 0) continue;
      tally[surface] = { ...tally[surface], [key]: Math.min(n, CEILING) };
    }
  }
  return tally;
}

const read = async (db: Queryable) =>
  tallyOf(
    (await db.select().from(gatewaySettings).where(eq(gatewaySettings.key, KEY)).limit(1))[0]
      ?.value,
  );

/** Changes the kept counts under the installation's lock, dropping what reached nothing. */
function change(store: Store, by: (tally: Tally) => void) {
  return store.transaction(GATEWAY_SCOPE, async (tx) => {
    const tally = await read(tx);
    by(tally);
    for (const surface of SURFACES) {
      const counts = tally[surface];
      if (!counts) continue;
      for (const [key, n] of Object.entries(counts)) {
        if (n <= 0) delete counts[key as PanelFeature];
      }
      if (!Object.keys(counts).length) delete tally[surface];
    }
    await tx
      .insert(gatewaySettings)
      .values({ key: KEY, value: tally })
      .onConflictDoUpdate({
        target: gatewaySettings.key,
        set: { value: tally, updatedAt: new Date() },
      });
  });
}

/** Adds what one panel counted. The caller has checked that the report is on. */
export function recordPanelUsage(store: Store, usage: PanelUsage) {
  const surface: Surface = `${usage.host}${usage.phone ? '_phone' : ''}`;
  return change(store, (tally) => {
    const counts: Counts = { ...tally[surface] };
    for (const [key, n] of Object.entries(usage.counts)) {
      if (!known.has(key) || !n) continue;
      const feature = key as PanelFeature;
      counts[feature] = Math.min((counts[feature] ?? 0) + n, CEILING);
    }
    tally[surface] = counts;
  });
}

/**
 * The report's `panel_usage` event, from what the panel counted since the last report that was
 * delivered, and `delivered` to take what it carried off. Taken off, not reset: what a panel hands
 * in while the report is on its way stays for the next one. No event while nothing was counted.
 *
 * `features` is every key summed; `hosts` the same by surface (`web`, `web_phone`, `desktop`,
 * `desktop_phone`), only those that counted something.
 */
export async function panelUsageEvents(
  store: Store,
  /** What every event of the report carries: its id, its time and the common properties. */
  base: { distinct_id: unknown; timestamp: string; properties: Record<string, unknown> },
) {
  const hosts = await read(store.db);
  const features: Counts = {};
  for (const counts of Object.values(hosts)) {
    for (const [key, n] of Object.entries(counts)) {
      const feature = key as PanelFeature;
      features[feature] = (features[feature] ?? 0) + n;
    }
  }
  if (!Object.keys(features).length) return { events: [], delivered: async () => {} };

  return {
    events: [
      {
        event: 'panel_usage',
        ...base,
        properties: { ...base.properties, features, hosts },
      },
    ],
    // A failure here only means the same counts are sent again tomorrow; the report itself went.
    delivered: () =>
      change(store, (tally) => {
        for (const surface of SURFACES) {
          const sent = hosts[surface];
          const counts = tally[surface];
          if (!sent || !counts) continue;
          for (const [key, n] of Object.entries(sent)) {
            const feature = key as PanelFeature;
            counts[feature] = (counts[feature] ?? 0) - n;
          }
        }
      }).catch(() => {}),
  };
}
