import { randomUUID } from 'node:crypto';
import { arch, platform } from 'node:os';
import { eq } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { GATEWAY_SCOPE } from '../security/gateway-vault.js';
import type { Queryable, Store } from '../storage/database.js';
import { gatewaySettings } from '../storage/schema.js';
import { installationFacts, usageBetween } from './report.js';

/**
 * Where the reports go: Jian's PostHog project. The key is public by design, it can only add
 * events; without one nothing is sent.
 */
export const TELEMETRY_DESTINATION = {
  key: 'phc_nRQ3DYPUxhGK2QzeH58h2rcNTf9xw6obQrk4ge5pJPgE',
  host: 'https://eu.i.posthog.com',
};

/** One report a day, at most, for the day before it. */
export const REPORT_EVERY_MS = 24 * 60 * 60 * 1000;

const SETTING = 'telemetry';
const INSTALLATION = 'telemetryInstallation';
const REPORTED_AT = 'telemetryReportedAt';
/** The day of the first report, kept for the installation's age. */
const FIRST_REPORTED = 'telemetryFirstReportedAt';
/** The release the last report was sent from, to say what an upgrade came from. */
const REPORTED_VERSION = 'telemetryVersion';

const DAY_MS = 24 * 60 * 60 * 1000;

type Facts = Awaited<ReturnType<typeof installationFacts>>;

/**
 * What the installation's profile in PostHog holds, for cohorts and retention: the same counts
 * and fixed words as the report, totalled, and never anything the owner typed.
 */
function profileOf(
  facts: Facts,
  system: Record<string, string>,
  age: number,
): Record<string, string | number | boolean> {
  const sum = (counts: Record<string, number>) =>
    Object.values(counts).reduce((total, n) => total + n, 0);
  return {
    ...system,
    agents: facts.agents,
    machines: facts.machines,
    schedules: facts.schedules,
    github_accounts: facts.github_accounts,
    x_accounts: facts.x_accounts,
    mcp_custom_servers: facts.mcp_custom_servers,
    providers_count: sum(facts.providers),
    mcp_apps_count: sum(facts.mcp_apps),
    channels_count: sum(facts.channels),
    has_whatsapp: Boolean(facts.channels.whatsapp),
    has_telegram: Boolean(facts.channels.telegram),
    has_email: Boolean(facts.channels.email),
    installation_age_days: age,
  };
}

export type TelemetryState = {
  enabled: boolean;
  /** `environment` when the host turned it off, which no setting overrides. */
  source: 'default' | 'setting' | 'environment';
};

/**
 * Whether the host turned telemetry off: `DO_NOT_TRACK=1`, the convention many tools honour, or
 * `JIAN_TELEMETRY=off`.
 */
export function offByEnvironment(env: NodeJS.ProcessEnv): boolean {
  const truthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value ?? '');
  const falsy = (value: string | undefined) => /^(0|false|no|off)$/i.test(value ?? '');
  return truthy(env.DO_NOT_TRACK) || falsy(env.JIAN_TELEMETRY);
}

const read = async (db: Queryable, key: string) =>
  (await db.select().from(gatewaySettings).where(eq(gatewaySettings.key, key)).limit(1))[0]?.value;

const write = (db: Queryable, key: string, value: unknown) =>
  db
    .insert(gatewaySettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: gatewaySettings.key, set: { value, updatedAt: new Date() } });

/**
 * Anonymous telemetry: once a day, what the installation is and what it did, counted, under an
 * id drawn at random for it. Never a message, a name, an address, a credential or what an agent
 * worked on. On by default; Settings → General turns it off, and so does the host's environment.
 */
export class Telemetry {
  constructor(
    private readonly store: Store,
    private readonly options: {
      env: NodeJS.ProcessEnv;
      fetcher: typeof globalThis.fetch;
      /** The release; a development build has none and never reports. */
      version: string | undefined;
      mode: 'server' | 'local';
      role: 'all' | 'api' | 'worker';
      clock?: Clock;
      destination?: { key: string; host: string };
    },
  ) {}

  async state(db: Queryable = this.store.db): Promise<TelemetryState> {
    if (offByEnvironment(this.options.env)) return { enabled: false, source: 'environment' };
    const chosen = await read(db, SETTING);
    return typeof chosen === 'boolean'
      ? { enabled: chosen, source: 'setting' }
      : { enabled: true, source: 'default' };
  }

  async set(enabled: boolean): Promise<void> {
    await write(this.store.db, SETTING, enabled);
  }

  /**
   * Sends the day's report when one is due. The time it is sent at is claimed first, under the
   * installation's lock, so two workers never send one day twice; a report that could not be
   * delivered gives the claim back and is tried again on a later tick.
   */
  async reportIfDue(): Promise<boolean> {
    const destination = this.options.destination ?? TELEMETRY_DESTINATION;
    const version = this.options.version;
    if (!destination.key || !version) return false;
    if (!(await this.state()).enabled) return false;

    const now = new Date((this.options.clock ?? Date.now)());
    const claim = await this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const last = await read(tx, REPORTED_AT);
      const since = typeof last === 'string' ? new Date(last) : undefined;
      if (since && now.getTime() - since.getTime() < REPORT_EVERY_MS) return undefined;
      let installation = await read(tx, INSTALLATION);
      if (typeof installation !== 'string') {
        installation = randomUUID();
        await write(tx, INSTALLATION, installation);
      }
      const kept = await read(tx, FIRST_REPORTED);
      const first = typeof kept === 'string' ? kept : now.toISOString();
      if (typeof kept !== 'string') await write(tx, FIRST_REPORTED, first);
      await write(tx, REPORTED_AT, now.toISOString());
      const reported = await read(tx, REPORTED_VERSION);
      return {
        installation,
        since,
        last,
        first: new Date(first),
        reported: typeof reported === 'string' ? reported : undefined,
      };
    });
    if (!claim) return false;

    try {
      const from = claim.since ?? new Date(now.getTime() - REPORT_EVERY_MS);
      const facts = await installationFacts(this.store.db);
      const usage = await usageBetween(this.store.db, from, now);
      const system = {
        version,
        mode: this.options.mode,
        role: this.options.role,
        os: platform(),
        arch: arch(),
        node: process.versions.node.split('.')[0] ?? '',
      };
      const common = {
        ...system,
        // A profile per installation, under its random id, so installations can be grouped and
        // followed over time in cohorts and retention. It is still no person: nothing identifies
        // or aliases it, it holds only the report's counts, and no place is looked up.
        $process_person_profile: true,
        $geoip_disable: true,
        $lib: 'jian-gateway',
      };
      const age = Math.max(0, Math.floor((now.getTime() - claim.first.getTime()) / DAY_MS));
      const upgradedFrom =
        claim.reported && claim.reported !== version ? { upgraded_from: claim.reported } : {};
      const response = await this.options.fetcher(`${destination.host}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: destination.key,
          batch: [
            {
              event: 'gateway_active',
              distinct_id: claim.installation,
              timestamp: now.toISOString(),
              properties: {
                ...common,
                ...facts,
                installation_age_days: age,
                ...upgradedFrom,
                $set: profileOf(facts, system, age),
                $set_once: {
                  first_seen: claim.first.toISOString().slice(0, 10),
                  first_version: version,
                },
              },
            },
            {
              event: 'gateway_usage',
              distinct_id: claim.installation,
              timestamp: now.toISOString(),
              properties: { ...common, ...usage, since: from.toISOString() },
            },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Only once delivered: an upgrade is said until a report carrying it has gone out.
      await write(this.store.db, REPORTED_VERSION, version).catch(() => {});
      return true;
    } catch {
      const giveBack =
        claim.last === undefined
          ? this.store.db.delete(gatewaySettings).where(eq(gatewaySettings.key, REPORTED_AT))
          : write(this.store.db, REPORTED_AT, claim.last);
      await Promise.resolve(giveBack).catch(() => {});
      return false;
    }
  }
}
