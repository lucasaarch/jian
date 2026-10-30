import { McpLogins } from './agent/mcp-login.js';
import { AgentRuntime } from './agent/runtime.js';
import { createApp } from './app.js';
import { ApiChannel } from './channels/api.js';
import type { Channel } from './channels/channel.js';
import { ChannelRegistry } from './channels/registry.js';
import { Channels } from './channels/service.js';
import { TelegramChannel } from './channels/telegram.js';
import type { WhatsAppConnections } from './channels/whatsapp/connections.js';
import { WhatsAppBusinessChannel } from './channels/whatsapp-business.js';
import { Coordination } from './coordination/service.js';
import { GitHubIntegrations } from './integrations/github.js';
import { moveMcpSecrets } from './mcp/move-secrets.js';
import { ModelCatalog } from './providers/catalog-source.js';
import { CodexLogin } from './providers/codex/login.js';
import { ProviderModels } from './providers/discovery.js';
import { ModelFallback } from './providers/fallback.js';
import { TierModels } from './providers/tiers.js';
import type { RunExecutor } from './runs/executors.js';
import { RunQueue } from './runs/queue.js';
import type { SecretBox } from './security/crypto.js';
import { GatewayVault } from './security/gateway-vault.js';
import { createSafeFetch } from './security/outbound.js';
import { Vault } from './security/vault.js';
import { buildServices } from './services.js';
import { Skills } from './skills/service.js';
import { importWorkspaceSshKeys } from './ssh/import.js';
import type { StartupStage } from './startup.js';
import type { Store } from './storage/database.js';

/**
 * How often due schedules and Listening polls are looked for, in milliseconds. A schedule set
 * for 08:00 starts within this much of it; every worker looks, and a schedule starts once
 * however many do. Subscriptions poll GitHub on their own interval, checked on this tick.
 */
const SCHEDULE_TICK_MS = 15_000;

export type GatewayOptions = {
  store: Store;
  box: SecretBox;
  token: string;
  /**
   * Where the gateway's work happens: `all` serves the API and runs agents, `api` only serves,
   * `worker` only runs. A worker has no HTTP server.
   */
  role: 'all' | 'api' | 'worker';
  /** Where queued runs are executed; required unless the role is `api`. */
  executor?: RunExecutor;
  /**
   * The messaging apps agents can be reached on. The desktop app's own gateway has none: it
   * lives on a computer that is not always on, so it serves the panel's chats alone.
   */
  channels: 'all' | 'none';
  allowPrivateOrigins: string[];
  /** Whether agents and providers may reach services on this computer itself. */
  allowLoopback?: boolean;
  trustedProxies: string[];
  publicUrl?: string;
  timeZone?: string;
};

export type Gateway = {
  /** Migrates, starts the queue and channels, then listens when this role serves HTTP. */
  start(listen?: { host: string; port: number }): Promise<{ url?: string }>;
  stop(): Promise<void>;
  /** Which part of `start` was running, for a failure to name what to check. */
  stage(): StartupStage;
};

/**
 * Everything a gateway is, from its store and keys: services, agents, channels, the HTTP API and
 * the run queue. The server image and the desktop app build it the same way; they differ in the
 * store, the executor and the channels they pass.
 */
export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const { store, box } = options;
  const outbound = createSafeFetch({
    allowPrivateOrigins: options.allowPrivateOrigins,
    ...(options.allowLoopback ? { allowLoopback: true } : {}),
  });

  // What each model can do is read from a catalog maintained outside this repository, so a model
  // released today works today. It goes out through the same guarded client as every other
  // provider call. Media routing loads it before deciding whether native vision is available.
  const catalog = new ModelCatalog(outbound.fetch);

  const vault = new Vault(store, box);
  // Vendor credentials belong to the installation; everything else a profile types is its own.
  const gatewayVault = new GatewayVault(store, box);
  const github = new GitHubIntegrations(
    store,
    gatewayVault,
    options.publicUrl,
    outbound.fetch,
    Date.now,
  );
  // The store rides along: several consumers read records no single area owns.
  const services = {
    ...buildServices({
      store,
      vault,
      gatewayVault,
      catalog,
      fetcher: outbound.fetch,
      github,
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }),
    store,
  };
  const codexLogin = new CodexLogin(services, gatewayVault);
  services.media.useCodexLogin(codexLogin);
  services.subscriptionUsage.useCodexLogin(codexLogin);

  const providerModels = new ProviderModels(
    { providers: services.providers, vault: gatewayVault },
    outbound.fetch,
    { catalog, codexLogin },
  );

  // A profile answers as soon as a provider exists: with no model chosen, one is taken from what
  // the provider reports and written as the profile's default.
  services.runs.useFallback(new ModelFallback(services.providers, providerModels, catalog));
  // A subagent gets the model its tier calls for, subscriptions first.
  services.work.useTiers(new TierModels(services.providers, providerModels, catalog));

  // Skill import reaches GitHub through the same guarded client, and only for the owner.
  const skills = new Skills(services.profiles, outbound.fetch);

  // An MCP server that wants OAuth sends the owner's browser back here, so a gateway with no
  // public address configured cannot offer that sign-in at all.
  const mcpLogins = options.publicUrl
    ? new McpLogins(gatewayVault, options.publicUrl, outbound.fetch)
    : undefined;

  const coordination = new Coordination(services);
  const whatsapp = options.channels === 'all' ? await linkedWhatsApp(store, box) : undefined;
  const adapters: Channel[] =
    options.channels === 'all' && whatsapp
      ? [
          new ApiChannel(),
          new TelegramChannel(),
          new WhatsAppBusinessChannel(),
          await whatsAppChannel(whatsapp),
        ]
      : [];
  const channels = new Channels(services, outbound.fetch, new ChannelRegistry(adapters));

  channels.usePublicUrl(options.publicUrl);

  // A colleague's late answer has no incoming message to hang a delivery on; channels give it one.
  services.peers.useDeliveries(channels);
  // Nor has a run a schedule starts in a chat: its answer goes out the same way.
  services.schedules.useDeliveries(channels);
  // A completed subagent wakes its principal in the source chat, including its channel.
  services.work.useDeliveries(channels);
  // An open session objective queues the next slice the same way after a completed turn.
  services.objectives.useDeliveries(channels);
  // Answering a mid-run question from the panel resumes a channel run the same way.
  services.runs.useDeliveries(channels);
  // A matching GitHub event (poll or optional webhook) wakes the subscribed session the same way.
  services.subscriptions.useDeliveries(channels);
  // Private repositories are polled with the connected account's installation token.
  services.subscriptions.useGithub(outbound.fetch, github);

  // Deleting a profile disconnects its channels first, inside the same transaction: a WhatsApp
  // socket a worker still holds open has to be told, not just left to find out from a missing row.
  services.profiles.useBeforeDelete((profileId, tx) => channels.revokeAll(profileId, tx));

  const runtime = new AgentRuntime(services, undefined, {
    gatewayVault,
    github,
    ...(mcpLogins ? { mcpOAuth: mcpLogins.provider } : {}),
    codexLogin,
    outbound,
    storeArtifact: (run, toolName, output) => coordination.storeArtifact(run, toolName, output),
  });

  const queue =
    options.role !== 'api' && options.executor
      ? new RunQueue(options.executor, services, runtime)
      : undefined;

  const app =
    options.role !== 'worker'
      ? createApp({
          ...services,
          github,
          codexLogin,
          providerModels,
          skills,
          channels,
          ...(whatsapp ? { whatsapp } : {}),
          ...(mcpLogins ? { mcpLogins } : {}),
          fetcher: outbound.fetch,
          token: options.token,
          trustedProxies: options.trustedProxies,
          onCancel: (id) => runtime.cancel(id),
        })
      : undefined;

  let scheduleTimer: ReturnType<typeof setInterval> | undefined;
  let stage: StartupStage = 'database';
  let stopping: Promise<void> | undefined;

  return {
    stage: () => stage,

    async start(listen) {
      stage = 'database';
      await store.migrate();
      // Secrets of the MCP servers migration 0071 made the installation's; nothing once done.
      await moveMcpSecrets(store, vault, gatewayVault);
      // SSH keys that still live only as files in an agent's workspace; nothing once imported.
      await importWorkspaceSshKeys(store, gatewayVault);
      stage = 'queue';
      await queue?.start();

      if (options.role !== 'api') {
        whatsapp?.start((id, input, generation) => channels.receiveLinked(id, input, generation));
        channels.start();
        scheduleTimer = setInterval(() => {
          void services.schedules
            .fireDue()
            .catch(() => console.error('jian: schedules could not be started; will retry'));
          void services.subscriptions
            .pollDue()
            .catch(() => console.error('jian: subscription poll failed; will retry'));
        }, SCHEDULE_TICK_MS);
        scheduleTimer.unref();
      }

      if (!app || !listen) return {};
      stage = 'http';
      return { url: await app.listen(listen) };
    },

    stop() {
      stopping ??= (async () => {
        codexLogin.stop();
        clearInterval(scheduleTimer);
        // End long-lived event streams before waiting for HTTP shutdown.
        app?.server.closeAllConnections();
        await app?.close();
        await queue?.stop();
        await channels.stop();
        await whatsapp?.stop();
        await outbound.close();
        await store.close();
      })();
      return stopping;
    },
  };
}

/** WhatsApp's linked-device library is large; a gateway without channels never loads it. */
async function linkedWhatsApp(store: Store, box: SecretBox): Promise<WhatsAppConnections> {
  const [{ WhatsAppConnections }, { createWhatsAppDeviceFactory }] = await Promise.all([
    import('./channels/whatsapp/connections.js'),
    import('./channels/whatsapp/driver.js'),
  ]);
  return new WhatsAppConnections(store, box, createWhatsAppDeviceFactory());
}

async function whatsAppChannel(connections: WhatsAppConnections): Promise<Channel> {
  const { WhatsAppChannel } = await import('./channels/whatsapp/adapter.js');
  return new WhatsAppChannel(connections);
}
