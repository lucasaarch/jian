import { randomBytes, randomUUID } from 'node:crypto';
import {
  type Device,
  type DevicePaired,
  type DevicePairing,
  deviceFocusInputSchema,
  devicePairInputSchema,
  devicePatchSchema,
  devicePushInputSchema,
} from '@jian/contracts';
import { and, desc, eq, gt, isNotNull, isNull, ne } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { GATEWAY_SCOPE } from '../security/gateway-vault.js';
import type { Store } from '../storage/database.js';
import { devicePairings, devices } from '../storage/schema.js';
import { DEVICE_TOKEN_PREFIX, hashSecret, newDeviceToken } from './tokens.js';

/** A pairing code is for one scan right after the QR code appears. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/** `last_seen_at` is for the owner to read, so a request per second need not write a row each time. */
const SEEN_EVERY_MS = 60 * 1000;

// A real token is the prefix and 43 characters; anything else is refused before it reaches a query.
const BEARER = new RegExp(`^Bearer (${DEVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{43})$`);

type Row = typeof devices.$inferSelect;

const present = (row: Row): Device => ({
  id: row.id,
  name: row.name,
  platform: row.platform,
  previews: row.previews,
  push: row.pushToken !== null,
  createdAt: row.createdAt.toISOString(),
  lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
});

/** The phones the owner paired: pairing, their own tokens, and what push needs to know of them. */
export class Devices {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock = Date.now,
  ) {}

  async createPairing(publicUrl: string | undefined): Promise<DevicePairing> {
    if (!publicUrl) {
      throw new GatewayError(
        409,
        'Set JIAN_PUBLIC_URL to the address phones reach this gateway at, then pair again.',
      );
    }
    const code = randomBytes(24).toString('base64url');
    const expiresAt = new Date(this.clock() + PAIRING_TTL_MS);
    await this.store.db.insert(devicePairings).values({ codeHash: hashSecret(code), expiresAt });
    return { url: publicUrl.replace(/\/+$/, ''), code, expiresAt: expiresAt.toISOString() };
  }

  async pair(input: unknown): Promise<DevicePaired> {
    const { code, name, platform } = devicePairInputSchema.parse(input);
    const now = new Date(this.clock());
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      // One statement spends the code, so two phones sending it together cannot both win.
      const spent = await tx
        .update(devicePairings)
        .set({ usedAt: now })
        .where(
          and(
            eq(devicePairings.codeHash, hashSecret(code)),
            isNull(devicePairings.usedAt),
            gt(devicePairings.expiresAt, now),
          ),
        )
        .returning({ codeHash: devicePairings.codeHash });
      if (spent.length === 0) {
        throw new GatewayError(
          401,
          'This pairing code is not valid. Show a new QR code and scan again.',
        );
      }
      const { token, hash } = newDeviceToken();
      const [row] = await tx
        .insert(devices)
        .values({ id: randomUUID(), name, platform, tokenHash: hash, createdAt: now })
        .returning();
      return { device: present(assertFound(row, 'Device')), token };
    });
  }

  async list(): Promise<Device[]> {
    const rows = await this.store.db
      .select()
      .from(devices)
      .where(isNull(devices.revokedAt))
      .orderBy(desc(devices.createdAt));
    return rows.map(present);
  }

  async update(id: string, patch: unknown): Promise<Device> {
    const { name, previews } = devicePatchSchema.parse(patch);
    const [row] = await this.store.db
      .update(devices)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(previews !== undefined ? { previews } : {}),
      })
      .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
      .returning();
    if (!row) throw new GatewayError(404, 'Device not found');
    return present(row);
  }

  async revoke(id: string): Promise<void> {
    // The push token goes too: a revoked phone must not keep receiving what the agent says.
    const revoked = await this.store.db
      .update(devices)
      .set({ revokedAt: new Date(this.clock()), pushToken: null, focusedSession: null })
      .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
      .returning({ id: devices.id });
    if (revoked.length === 0) throw new GatewayError(404, 'Device not found');
  }

  /** The device id behind an `Authorization` header value, or undefined. Never throws. */
  async authenticate(bearer: string): Promise<string | undefined> {
    const token = BEARER.exec(bearer)?.[1];
    if (!token) return undefined;
    const [row] = await this.store.db
      .select({ id: devices.id, lastSeenAt: devices.lastSeenAt })
      .from(devices)
      .where(and(eq(devices.tokenHash, hashSecret(token)), isNull(devices.revokedAt)))
      .limit(1);
    if (!row) return undefined;
    const now = this.clock();
    if (!row.lastSeenAt || now - row.lastSeenAt.getTime() >= SEEN_EVERY_MS) {
      await this.store.db
        .update(devices)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(devices.id, row.id));
    }
    return row.id;
  }

  async setPush(id: string, input: unknown): Promise<Device> {
    const { pushToken } = devicePushInputSchema.parse(input);
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      // A reinstalled app or a handed-down phone reports a token another row still holds;
      // leaving both would notify the old row's owner twice.
      if (pushToken) {
        await tx
          .update(devices)
          .set({ pushToken: null })
          .where(and(eq(devices.pushToken, pushToken), ne(devices.id, id)));
      }
      const [row] = await tx
        .update(devices)
        .set({ pushToken })
        .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
        .returning();
      if (!row) throw new GatewayError(404, 'Device not found');
      return present(row);
    });
  }

  async setFocus(id: string, input: unknown): Promise<void> {
    const { sessionId } = deviceFocusInputSchema.parse(input);
    const set = await this.store.db
      .update(devices)
      .set({ focusedSession: sessionId })
      .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
      .returning({ id: devices.id });
    if (set.length === 0) throw new GatewayError(404, 'Device not found');
  }

  async pushTargets(): Promise<
    Array<{ id: string; pushToken: string; previews: boolean; focusedSession: string | null }>
  > {
    const rows = await this.store.db
      .select()
      .from(devices)
      .where(and(isNull(devices.revokedAt), isNotNull(devices.pushToken)));
    return rows.flatMap((row) =>
      row.pushToken
        ? [
            {
              id: row.id,
              pushToken: row.pushToken,
              previews: row.previews,
              focusedSession: row.focusedSession,
            },
          ]
        : [],
    );
  }

  /** The push service said the token is dead; stop sending to it. */
  async forgetPushToken(pushToken: string): Promise<void> {
    await this.store.db
      .update(devices)
      .set({ pushToken: null })
      .where(eq(devices.pushToken, pushToken));
  }
}
