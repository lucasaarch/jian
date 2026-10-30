import { createJianClient } from '@jian/sdk';
import type { GatewayStatus, GatewaySummary } from '../../shared/bridge';
import { timedFetch } from './fetch';
import { type AgentKnown, type ListedSession, type News, type OpenRun, readNews } from './news';
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

/** Something new in a conversation the app may announce: a reply, a message, or a request. */
export type Notice = News & {
  gatewayId: string;
  profileId: string;
  profileName: string;
};

type Watch = {
  status: GatewayStatus;
  version?: string;
  unread: number;
  /** What each agent's conversations held at the last look; an agent not in it was never read. */
  known: Map<string, AgentKnown>;
  timer?: NodeJS.Timeout;
  /** A look is under way; `again` asks for another as soon as it ends. */
  looking?: boolean;
  again?: boolean;
};

/**
 * Keeps every gateway's standing in the main process, window or not: whether it answers, its
 * release, its unread chats, and what is new in its conversations — a reply, a message, a
 * question or an approval waiting — which the app may turn into a notification.
 */
export class GatewayMonitor {
  private readonly watches = new Map<string, Watch>();
  /** Why a gateway this app runs could not start, said where it is shown. */
  private readonly failures = new Map<string, string>();

  constructor(
    private readonly store: GatewayStore,
    private readonly appVersion: string,
    private readonly events: { changed(): void; noticed(notice: Notice): void },
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
        ...(this.failures.has(gateway.id) ? { failure: this.failures.get(gateway.id) } : {}),
        unread: watch?.unread ?? 0,
      };
    });
  }

  /** The app's own gateway could not start, and why; undefined once it does. */
  failed(id: string, reason: string | undefined): void {
    if (reason === undefined) this.failures.delete(id);
    else this.failures.set(id, reason);
    this.events.changed();
  }

  watch(gateway: StoredGateway): void {
    this.forget(gateway.id);
    this.watches.set(gateway.id, { status: 'connecting', unread: 0, known: new Map() });
    void this.look(gateway.id);
  }

  forget(id: string): void {
    clearTimeout(this.watches.get(id)?.timer);
    this.watches.delete(id);
  }

  /** Asked again now: the window turned to the gateway, or the computer woke up. */
  refresh(id?: string): void {
    for (const gatewayId of id ? [id] : [...this.watches.keys()]) {
      const watch = this.watches.get(gatewayId);
      if (!watch) continue;
      // One look at a time: two would each tell the same news, and the slower one would put
      // back what the faster had already moved past, to be told once more.
      if (watch.looking) {
        watch.again = true;
        continue;
      }
      clearTimeout(watch.timer);
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
    watch.looking = true;
    try {
      await this.read(gateway, watch);
    } catch {
      watch.status = 'offline';
    } finally {
      watch.looking = false;
    }
    if (this.watches.get(id) !== watch) return;
    if (`${watch.status}:${watch.version}:${watch.unread}` !== before) this.events.changed();
    if (watch.again) {
      watch.again = false;
      void this.look(id);
      return;
    }
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

    // It answers: that is settled. Reading the conversations reads every agent's lists, and
    // one slow or failed list only leaves what was known of that agent; it never makes the
    // gateway look away.
    await this.count(gateway, client, profiles.data, watch).catch(() => undefined);
  }

  /**
   * Each agent's conversations and open runs: the unread count, and what is new since the last
   * look. An agent's first look only learns, so a list that failed before is not taken, once it
   * reads, for a burst of news.
   */
  private async count(
    gateway: StoredGateway,
    client: ReturnType<typeof createJianClient>,
    profiles: { id: string; name: string }[],
    watch: Watch,
  ): Promise<void> {
    const known = new Map<string, AgentKnown>();
    const notices: Notice[] = [];
    for (const profile of profiles) {
      const before = watch.known.get(profile.id);
      const params = { params: { path: { profileId: profile.id } } };
      const [sessions, runs] = await Promise.all([
        client.GET('/v1/profiles/{profileId}/sessions', params).catch(() => undefined),
        client.GET('/v1/profiles/{profileId}/activities', params).catch(() => undefined),
      ]);
      if (!sessions?.data) {
        if (before) known.set(profile.id, before);
        continue;
      }
      const read = readNews(
        before,
        sessions.data as ListedSession[],
        runs?.data as OpenRun[] | undefined,
      );
      known.set(profile.id, read.known);
      for (const news of read.news) {
        notices.push({
          ...news,
          gatewayId: gateway.id,
          profileId: profile.id,
          profileName: profile.name,
        });
      }
    }
    // Forgotten or watched afresh meanwhile: what this look found belongs to no one now.
    if (this.watches.get(gateway.id) !== watch) return;
    watch.known = known;
    watch.unread = [...known.values()].reduce((sum, agent) => sum + agent.unread, 0);
    for (const notice of notices) this.events.noticed(notice);
  }
}
