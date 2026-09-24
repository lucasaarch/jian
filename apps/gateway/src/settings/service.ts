import { type GatewaySettings, gatewaySettingsPatchSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { gatewayTimeZone } from '../core/time-zone.js';
import type { Store } from '../storage/database.js';
import { gatewaySettings } from '../storage/schema.js';

/** Settings of the whole installation: what every profile shares, such as its time zone. */
export class Settings {
  constructor(private readonly store: Store) {}

  async read(): Promise<GatewaySettings> {
    const [row] = await this.store.db
      .select()
      .from(gatewaySettings)
      .where(eq(gatewaySettings.key, 'timeZone'))
      .limit(1);
    const chosen = typeof row?.value === 'string' ? row.value : undefined;

    return chosen
      ? { timeZone: chosen, timeZoneSource: 'setting' }
      : { timeZone: gatewayTimeZone(), timeZoneSource: 'host' };
  }

  /** The zone agents read the time in and schedules default to. */
  async timeZone() {
    return (await this.read()).timeZone;
  }

  async update(input: unknown) {
    const { timeZone } = gatewaySettingsPatchSchema.parse(input);

    if (timeZone === null) {
      await this.store.db.delete(gatewaySettings).where(eq(gatewaySettings.key, 'timeZone'));
    } else {
      await this.store.db
        .insert(gatewaySettings)
        .values({ key: 'timeZone', value: timeZone })
        .onConflictDoUpdate({
          target: gatewaySettings.key,
          set: { value: timeZone, updatedAt: new Date() },
        });
    }

    return this.read();
  }
}
