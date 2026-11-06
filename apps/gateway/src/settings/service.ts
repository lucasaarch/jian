import {
  type GatewaySettings,
  gatewaySettingsPatchSchema,
  protectionModeSchema,
} from '@jian/contracts';
import { eq, inArray } from 'drizzle-orm';
import { gatewayTimeZone } from '../core/time-zone.js';
import type { Store } from '../storage/database.js';
import { gatewaySettings } from '../storage/schema.js';
import type { Telemetry } from '../telemetry/service.js';

const NEW_CHAT_PROTECTION = 'newChatProtection';

/** Settings of the whole installation: what every profile shares, such as its time zone. */
export class Settings {
  private telemetry?: Pick<Telemetry, 'state' | 'set'>;

  constructor(
    private readonly store: Store,
    private readonly configuredTimeZone?: string,
  ) {}

  /** Set by the gateway, which knows the host it reports from. */
  useTelemetry(telemetry: Pick<Telemetry, 'state' | 'set'>) {
    this.telemetry = telemetry;
  }

  async read(): Promise<GatewaySettings> {
    const telemetry = this.telemetry ? { telemetry: await this.telemetry.state() } : {};
    return { ...(await this.zoneAndChat()), ...telemetry };
  }

  private async zoneAndChat(): Promise<GatewaySettings> {
    const rows = await this.store.db
      .select()
      .from(gatewaySettings)
      .where(inArray(gatewaySettings.key, ['timeZone', NEW_CHAT_PROTECTION]));
    const value = (key: string) => rows.find((row) => row.key === key)?.value;
    const protection = protectionModeSchema.safeParse(value(NEW_CHAT_PROTECTION));
    const newChat = protection.success ? { newChatProtection: protection.data } : {};
    // The environment wins without deleting a previously saved value, so removing the var
    // restores the old setting during a rollback.
    if (this.configuredTimeZone) {
      return { timeZone: this.configuredTimeZone, timeZoneSource: 'setting', ...newChat };
    }
    const chosen = value('timeZone');

    return typeof chosen === 'string'
      ? { timeZone: chosen, timeZoneSource: 'setting', ...newChat }
      : { timeZone: gatewayTimeZone(), timeZoneSource: 'host', ...newChat };
  }

  /** The zone agents read the time in and schedules default to. */
  async timeZone() {
    return (await this.read()).timeZone;
  }

  async update(input: unknown) {
    const { timeZone, newChatProtection, telemetry } = gatewaySettingsPatchSchema.parse(input);
    if (telemetry !== undefined) await this.telemetry?.set(telemetry);
    if (timeZone === null) {
      await this.store.db.delete(gatewaySettings).where(eq(gatewaySettings.key, 'timeZone'));
    } else if (timeZone !== undefined) {
      await this.write('timeZone', timeZone);
    }
    if (newChatProtection) await this.write(NEW_CHAT_PROTECTION, newChatProtection);

    return this.read();
  }

  private async write(key: string, value: string) {
    await this.store.db
      .insert(gatewaySettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: gatewaySettings.key,
        set: { value, updatedAt: new Date() },
      });
  }
}
