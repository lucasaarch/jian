import { createHash, randomUUID } from 'node:crypto';
import { assertFound, GatewayError } from '../../core/errors.js';
import type { SecretBox } from '../../security/crypto.js';
import type { Queryable, Store } from '../../storage/database.js';
import type { DeliveryOutcome, IncomingMessage, OutgoingMessage } from '../channel.js';
import { channelLog } from '../logging.js';
import { findChannel, setChannelAddress } from '../repository.js';
import {
  claimConnection,
  countPendingInbox,
  findConnection,
  findInboxItem,
  insertInboxItem,
  listConnections,
  listConnectionsOwnedBy,
  listPendingInbox,
  readAuthChunks,
  readOwned,
  releaseConnection,
  settleInboxItem,
  updateOwned,
  writeAuthChunks,
  writeConnection,
} from './repository.js';
import type { ConnectionRecord, DeviceFactory, DeviceSessionStore, LinkedDevice } from './types.js';
import { DEVICE_SEND_TIMEOUT_MS } from './types.js';

const LEASE_MS = 30_000;
const QR_LIFETIME_MS = 45_000;
const AUTH_CHUNK_BYTES = 512 * 1024;
const INBOX_CAPACITY = 1000;
export const MAX_DEVICE_SESSION_BYTES = 64 * 1024 * 1024;

type Receiver = (id: string, input: IncomingMessage, generation: number) => Promise<unknown>;
type LocalDevice = { device: LinkedDevice; generation: number; fence: number };

/** Database leases keep API replicas independent from the worker that owns the device socket. */
export class WhatsAppConnections {
  private readonly owner = randomUUID();
  private readonly devices = new Map<string, LocalDevice>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly box: SecretBox,
    private readonly factory: DeviceFactory,
    private readonly clock = Date.now,
  ) {}

  private now() {
    return new Date(this.clock()).toISOString();
  }

  private async binding(profileId: string, id: string, reader: Queryable = this.store.db) {
    const value = await findChannel(reader, id);
    const channel = assertFound(value?.profileId === profileId ? value : null, 'Channel');

    if (channel.type !== 'whatsapp' || channel.revokedAt) {
      throw new GatewayError(409, 'WhatsApp channel unavailable');
    }

    return channel;
  }

  async connect(profileId: string, id: string) {
    await this.binding(profileId, id);

    await this.store.transaction(profileId, async (tx) => {
      const current = await findConnection(tx, id);

      if (current?.desired) {
        return;
      }

      await writeConnection(tx, {
        id,
        profileId,
        desired: true,
        generation: current?.generation ?? 1,
        fence: (current?.fence ?? 0) + 1,
        status: 'connecting',
        sessionSavedAt: current?.sessionSavedAt,
        accountId: current?.accountId,
        updatedAt: this.now(),
      });
    });

    return this.status(profileId, id);
  }

  async disconnect(profileId: string, id: string) {
    await this.binding(profileId, id);

    await this.store.transaction(profileId, async (tx) => {
      const current = await findConnection(tx, id);

      // Incrementing the generation fences every callback and backup from the old device.
      await writeConnection(tx, {
        id,
        profileId,
        desired: false,
        generation: (current?.generation ?? 0) + 1,
        status: 'disconnected',
        updatedAt: this.now(),
      });
      await writeAuthChunks(tx, id, profileId, [], new Date(this.clock()));
    });

    return this.status(profileId, id);
  }

  async status(profileId: string, id: string) {
    await this.binding(profileId, id);
    const current = await findConnection(this.store.db, id);
    const stale = current?.desired && (current.leaseUntil ?? 0) <= this.clock();

    return {
      channelId: id,
      status: stale ? ('connecting' as const) : (current?.status ?? ('disconnected' as const)),
      accountId: current?.accountId,
      sessionSavedAt: current?.sessionSavedAt,
      updatedAt: current?.updatedAt ?? this.now(),
      error: current?.error,
    };
  }

  async qr(profileId: string, id: string) {
    await this.binding(profileId, id);
    const current = await findConnection(this.store.db, id);

    if (
      !current?.desired ||
      current.status !== 'qr' ||
      !current.qr ||
      (current.leaseUntil ?? 0) <= this.clock() ||
      (current.qrExpiresAt ?? 0) <= this.clock()
    ) {
      throw new GatewayError(409, 'No valid QR code is available');
    }

    return {
      qr: this.box.decrypt(current.qr, `jian:whatsapp:qr:${profileId}:${id}`),
      expiresAt: new Date(current.qrExpiresAt as number).toISOString(),
    };
  }

  /** Reading before a write that has no ownership predicate of its own. */
  private async owned(tx: Queryable, record: ConnectionRecord) {
    const current = await readOwned(tx, record, this.owner, this.clock());

    return assertOwned(current);
  }

  private async update(record: ConnectionRecord, patch: Partial<ConnectionRecord>) {
    await this.store.transaction(record.profileId, async (tx) => {
      assertOwned(
        await updateOwned(tx, record, this.owner, this.clock(), {
          ...patch,
          updatedAt: this.now(),
        }),
      );
    });
  }

  private sessionStore(record: ConnectionRecord): DeviceSessionStore {
    const aad = (index: number, total: number) =>
      `jian:whatsapp:auth:${record.profileId}:${record.id}:${index}:${total}`;

    return {
      load: () =>
        this.store.transaction(record.profileId, async (tx) => {
          await this.owned(tx, record);
          const chunks = await readAuthChunks(tx, record.id);

          if (!chunks?.length) {
            return undefined;
          }

          return Buffer.concat(
            chunks.map((chunk, index) =>
              Buffer.from(this.box.decrypt(chunk, aad(index, chunks.length)), 'base64'),
            ),
          );
        }),
      save: async (data) => {
        if (!data.length || data.length > MAX_DEVICE_SESSION_BYTES) {
          throw new Error('Invalid device session size');
        }

        const total = Math.ceil(data.length / AUTH_CHUNK_BYTES);
        const chunks = Array.from({ length: total }, (_, index) =>
          this.box.encrypt(
            data
              .subarray(index * AUTH_CHUNK_BYTES, (index + 1) * AUTH_CHUNK_BYTES)
              .toString('base64'),
            aad(index, total),
          ),
        );

        await this.store.transaction(record.profileId, async (tx) => {
          const current = await this.owned(tx, record);

          await writeAuthChunks(tx, record.id, record.profileId, chunks, new Date(this.clock()));
          assertOwned(
            await updateOwned(tx, current, this.owner, this.clock(), {
              sessionSavedAt: this.now(),
              updatedAt: this.now(),
            }),
          );
        });
      },
      clear: () =>
        this.store.transaction(record.profileId, async (tx) => {
          await this.owned(tx, record);
          await writeAuthChunks(tx, record.id, record.profileId, [], new Date(this.clock()));
        }),
    };
  }

  private async enqueue(record: ConnectionRecord, message: IncomingMessage) {
    await this.store.transaction(record.profileId, async (tx) => {
      await this.owned(tx, record);
      // Who may be answered is decided by contact approval, after the message is durable.
      assertFound(await findChannel(tx, record.id), 'Channel');

      const id = createHash('sha256')
        .update(JSON.stringify([record.id, message.requestKey]))
        .digest('hex');

      if (await findInboxItem(tx, id)) {
        return;
      }

      if ((await countPendingInbox(tx, record.id)) >= INBOX_CAPACITY) {
        throw new Error('WhatsApp inbox capacity reached');
      }

      await insertInboxItem(tx, {
        id,
        profileId: record.profileId,
        channelId: record.id,
        generation: record.generation,
        message,
        status: 'pending',
        receivedAt: this.now(),
      });
    });
  }

  private async open(record: ConnectionRecord) {
    const device = await this.factory(record.id, this.sessionStore(record), {
      qr: (value) =>
        this.update(record, {
          status: 'qr',
          qr: this.box.encrypt(value, `jian:whatsapp:qr:${record.profileId}:${record.id}`),
          qrExpiresAt: this.clock() + QR_LIFETIME_MS,
        }),
      ready: async (accountId) => {
        await this.store.transaction(record.profileId, async (tx) => {
          const current = await this.owned(tx, record);

          // A different phone requires an explicit disconnect, which invalidates queued replies.
          if (current.accountId && current.accountId !== accountId) {
            throw new GatewayError(409, 'Disconnect before linking a different WhatsApp account');
          }

          assertOwned(
            await updateOwned(tx, current, this.owner, this.clock(), {
              status: 'connected',
              accountId,
              qr: undefined,
              qrExpiresAt: undefined,
              error: undefined,
              updatedAt: this.now(),
            }),
          );

          // The paired account is also the address this profile speaks as in a room, which is
          // how the other agents of this installation recognise its messages as an agent's.
          const channel = await findChannel(tx, record.id);

          if (channel && channel.address !== accountId) {
            await setChannelAddress(tx, record.id, accountId);
          }
        });
      },
      disconnected: async (loggedOut) => {
        if (loggedOut) {
          await this.sessionStore(record).clear();
        }

        await this.update(record, {
          desired: !loggedOut,
          retryAt: this.clock() + 5000,
          generation: loggedOut ? record.generation + 1 : record.generation,
          status: loggedOut ? 'disconnected' : 'connecting',
          owner: undefined,
          leaseUntil: 0,
          qr: undefined,
          qrExpiresAt: undefined,
          ...(loggedOut ? { sessionSavedAt: undefined, accountId: undefined } : {}),
        });
      },
      message: (message) => this.enqueue(record, message),
      failed: () =>
        this.update(record, {
          desired: false,
          status: 'error',
          qr: undefined,
          qrExpiresAt: undefined,
          error:
            'WhatsApp connection failed. Check the worker configuration and network, then reconnect.',
        }),
    });

    this.devices.set(record.id, {
      device,
      generation: record.generation,
      fence: record.fence ?? 0,
    });
    void device.start().catch(async () => {
      await this.update(record, {
        desired: false,
        status: 'error',
        qr: undefined,
        qrExpiresAt: undefined,
        error:
          'WhatsApp connection failed. Check the worker configuration and network, then reconnect.',
      }).catch(() => {});
    });
  }

  async tick(receive: Receiver) {
    const records = await listConnections(this.store.db, 1000);
    const live = new Set(records.map((record) => record.id));

    // Deleting a profile cascades its channel and this row away in one transaction, with no
    // chance to mark `desired: false` where this worker could see it first — the row is simply
    // gone on the next poll. A device this worker still holds for an id that vanished from the
    // table has exactly the same one requirement any other stop does: `stop()` before this tick
    // ends. Snapshotting the ids first means a device opened by this same tick, after the
    // `records` read, is never mistaken for one whose row disappeared.
    for (const [channelId, local] of [...this.devices]) {
      if (!live.has(channelId)) {
        this.devices.delete(channelId);
        await local.device.stop(true).catch(() => {});
      }
    }

    for (const record of records) {
      const channel = await findChannel(this.store.db, record.id);
      const local = this.devices.get(record.id);
      const lostOwnership = record.owner !== this.owner || (record.leaseUntil ?? 0) <= this.clock();

      if (
        local &&
        (!record.desired ||
          channel?.revokedAt ||
          record.generation !== local.generation ||
          record.fence !== local.fence ||
          lostOwnership)
      ) {
        this.devices.delete(record.id);
        await local.device
          .stop(!record.desired || !!channel?.revokedAt || record.generation !== local.generation)
          .catch(() => {});
      }

      if (
        this.stopped ||
        !record.desired ||
        !channel ||
        channel.revokedAt ||
        (record.retryAt ?? 0) > this.clock()
      ) {
        continue;
      }

      // One statement decides and takes the device: the reservation is granted when it is
      // already this worker's or has run out, so nothing can be read, judged and written over.
      const claimed = await this.store.transaction(record.profileId, (tx) =>
        claimConnection(
          tx,
          record.id,
          this.owner,
          this.clock(),
          LEASE_MS,
          this.devices.has(record.id),
        ),
      );

      if (!claimed) {
        continue;
      }

      if (!this.devices.has(record.id)) {
        await this.open(claimed).catch(async () => {
          await this.update(claimed, {
            desired: false,
            status: 'error',
            error: 'Unable to start the WhatsApp device.',
          }).catch(() => {});
        });
      }

      for (const item of await listPendingInbox(this.store.db, record.id, 20)) {
        let status: 'submitted' | 'discarded' = 'submitted';

        try {
          await this.store.transaction(record.profileId, (tx) => this.owned(tx, claimed));

          if (item.generation !== claimed.generation) {
            status = 'discarded';
          } else {
            await receive(record.id, item.message, claimed.generation);
          }
        } catch (error) {
          // Session contention is transient; keep the message durable until its previous run finishes.
          if (error instanceof GatewayError && [400, 403, 404].includes(error.statusCode)) {
            status = 'discarded';
          } else {
            break;
          }
        }

        await this.store.transaction(record.profileId, async (tx) => {
          await this.owned(tx, claimed);
          await settleInboxItem(tx, item, status);
        });
      }
    }
  }

  async canSend(id: string, generation?: number) {
    const current = await findConnection(this.store.db, id);
    const local = this.devices.get(id);

    return !!(
      current?.desired &&
      current.status === 'connected' &&
      (generation === undefined || current.generation === generation) &&
      current.owner === this.owner &&
      // Leave enough ownership time for the bounded network attempt.
      (current.leaseUntil ?? 0) > this.clock() + DEVICE_SEND_TIMEOUT_MS &&
      local?.generation === current.generation &&
      local.fence === current.fence
    );
  }

  async send(
    id: string,
    message: OutgoingMessage,
    signal: AbortSignal,
    generation?: number,
  ): Promise<DeliveryOutcome> {
    const remoteMessageIds: string[] = [];
    let attempted = false;

    try {
      if (message.media) {
        signal.throwIfAborted();
        if (!(await this.canSend(id, generation))) return { status: 'failed', remoteMessageIds };
        const local = assertFound(this.devices.get(id), 'Device');
        attempted = true;
        remoteMessageIds.push(
          await local.device.send(message.chatId, message.text, signal, message.media),
        );
        return { status: 'sent', remoteMessageIds };
      }
      const characters = Array.from(message.text);

      for (let offset = 0; offset < characters.length; offset += 4000) {
        signal.throwIfAborted();

        if (!(await this.canSend(id, generation))) {
          return { status: attempted ? 'unknown' : 'failed', remoteMessageIds };
        }

        const local = assertFound(this.devices.get(id), 'Device');
        attempted = true;
        remoteMessageIds.push(
          await local.device.send(
            message.chatId,
            characters.slice(offset, offset + 4000).join(''),
            signal,
          ),
        );
      }

      return { status: 'sent', remoteMessageIds };
    } catch {
      // A timeout can follow a successful remote write. Never replay an uncertain message.
      return { status: attempted ? 'unknown' : 'failed', remoteMessageIds };
    }
  }

  async typing(id: string, chatId: string, generation?: number): Promise<void> {
    if (!(await this.canSend(id, generation))) {
      return;
    }

    await this.devices
      .get(id)
      ?.device.typing(chatId)
      .catch(() => undefined);
  }

  start(receive: Receiver) {
    const poll = async () => {
      if (this.stopped) return;
      this.pending = this.tick(receive).catch((error) =>
        channelLog('whatsapp.worker.failed', {}, error),
      );
      await this.pending;

      if (!this.stopped) {
        this.timer = setTimeout(poll, 2000);
        this.timer.unref();
      }
    };

    void poll();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
    await Promise.allSettled([...this.devices.values()].map((local) => local.device.stop(false)));
    this.devices.clear();

    const records = await listConnectionsOwnedBy(this.store.db, this.owner, 1000);

    for (const record of records) {
      await this.store.transaction(record.profileId, (tx) =>
        releaseConnection(tx, record.id, this.owner, record.desired ? 'connecting' : record.status),
      );
    }
  }
}

/** Losing the device mid-write is the same answer everywhere: the write does not land. */
function assertOwned(record: ConnectionRecord | null): ConnectionRecord {
  if (!record) {
    throw new GatewayError(409, 'Device ownership expired');
  }

  return record;
}
