import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import { createJianClient } from '@jian/sdk';
import type { GatewayStatus, GatewaySummary } from '../../shared/bridge';
import { timedFetch } from './fetch';
import { compatible, gatewayName } from './rules';
import type { GatewayStore, StoredGateway } from './store';

/**
 * How often a gateway is asked how it stands, in ms; a little slower while it is not answering.
 * Not much slower: the window holds its reads while the gateway is away, and they go on only
 * once it is seen answering again.
 */
const EVERY_MS = 15_000;
const OFFLINE_EVERY_MS = 20_000;
const TIMEOUT_MS = 8_000;

type Session = {
  id: string;
  title?: string | null;
  channel: string;
  readAt?: string;
  lastMessage?: { role: 'user' | 'assistant'; text: string; at: string };
};

/** A reply the owner has not read yet, which the app may announce. */
export type Reply = {
  gatewayId: string;
  profileId: string;
  profileName: string;
  sessionId: string;
  title: string;
  text: string;
};

/** The panel's own rule: a chat of the panel the agent wrote in since the owner last read it. */
function unread(session: Session): boolean {
  return (
    session.channel === GATEWAY_SESSION_CHANNEL &&
    session.lastMessage?.role === 'assistant' &&
    (!session.readAt || Date.parse(session.lastMessage.at) > Date.parse(session.readAt))
  );
}

type Watch = {
  status: GatewayStatus;
  version?: string;
  unread: number;
  /** The last word known in each chat; undefined until the first look, which only learns them. */
  known?: Map<string, string>;
  timer?: NodeJS.Timeout;
};

/**
 * Keeps every gateway's standing in the main process, window or not: whether it answers, its
 * release, its unread chats, and each new reply, which the app may turn into a notification.
 */
export class GatewayMonitor {
  private readonly watches = new Map<string, Watch>();

  constructor(
    private readonly store: GatewayStore,
    private readonly appVersion: string,
    private readonly events: { changed(): void; replied(reply: Reply): void },
  ) {}

  summaries(): GatewaySummary[] {
    return this.store.list().map((gateway) => {
      const watch = this.watches.get(gateway.id);
      return {
        id: gateway.id,
        name: gatewayName(gateway),
        local: gateway.local === true,
        url: gateway.url,
        status: watch?.status ?? 'connecting',
        ...(watch?.version ? { version: watch.version } : {}),
        unread: watch?.unread ?? 0,
      };
    });
  }

  watch(gateway: StoredGateway): void {
    this.forget(gateway.id);
    this.watches.set(gateway.id, { status: 'connecting', unread: 0 });
    void this.look(gateway.id);
  }

  forget(id: string): void {
    clearTimeout(this.watches.get(id)?.timer);
    this.watches.delete(id);
  }

  /** Asked again now: the owner just read a chat, or the computer woke up. */
  refresh(id?: string): void {
    for (const gatewayId of id ? [id] : [...this.watches.keys()]) {
      clearTimeout(this.watches.get(gatewayId)?.timer);
      void this.look(gatewayId);
    }
  }

  private async look(id: string): Promise<void> {
    const gateway = this.store.get(id);
    const watch = this.watches.get(id);
    if (!gateway || !watch) return;
    // The app's own gateway between launches of its process: it says when it listens again.
    if (!gateway.url) return;
    const before = `${watch.status}:${watch.version}:${watch.unread}`;
    try {
      await this.read(gateway, watch);
    } catch {
      watch.status = 'offline';
    }
    if (this.watches.get(id) !== watch) return;
    if (`${watch.status}:${watch.version}:${watch.unread}` !== before) this.events.changed();
    const every =
      watch.status === 'online' || watch.status === 'incompatible' ? EVERY_MS : OFFLINE_EVERY_MS;
    watch.timer = setTimeout(() => void this.look(id), every);
  }

  private async read(gateway: StoredGateway, watch: Watch): Promise<void> {
    const client = createJianClient({
      baseUrl: gateway.url,
      token: this.store.token(gateway),
      fetch: timedFetch(TIMEOUT_MS),
    });

    const health = await client.GET('/health');
    if (!health.data) throw new Error('unreachable');
    watch.version = health.data.version;
    if (!compatible(this.appVersion, watch.version)) {
      watch.status = 'incompatible';
      return;
    }

    const profiles = await client.GET('/v1/profiles');
    if (profiles.response.status === 401) {
      watch.status = 'unauthorized';
      return;
    }
    if (!profiles.data) throw new Error('unreachable');
    watch.status = 'online';

    // It answers: that is settled. Counting unread chats reads every agent's list, and one slow
    // or failed list only leaves the count as it was; it never makes the gateway look away.
    await this.count(gateway, client, profiles.data, watch).catch(() => undefined);
  }

  private async count(
    gateway: StoredGateway,
    client: ReturnType<typeof createJianClient>,
    profiles: { id: string; name: string }[],
    watch: Watch,
  ): Promise<void> {
    const first = !watch.known;
    const known = watch.known ?? new Map<string, string>();
    let count = 0;
    for (const profile of profiles) {
      const sessions = await client.GET('/v1/profiles/{profileId}/sessions', {
        params: { path: { profileId: profile.id } },
      });
      for (const session of (sessions.data ?? []) as Session[]) {
        const at = session.lastMessage?.at;
        if (!at) continue;
        const isUnread = unread(session);
        if (isUnread) count += 1;
        const key = `${profile.id}/${session.id}`;
        const seen = known.get(key);
        known.set(key, at);
        if (first || seen === at || !isUnread || !session.lastMessage) continue;
        this.events.replied({
          gatewayId: gateway.id,
          profileId: profile.id,
          profileName: profile.name,
          sessionId: session.id,
          title: session.title ?? 'New chat',
          text: session.lastMessage.text,
        });
      }
    }
    watch.known = known;
    watch.unread = count;
  }
}
