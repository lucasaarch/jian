import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { MAX_PATH_PARAM, operationSchema, operations } from '@jian/contracts';
import Fastify, { LogController } from 'fastify';
import type { McpLogins } from './agent/mcp-login.js';
import { registerArtifactRoutes } from './artifacts/routes.js';
import { registerOpenAiRoutes } from './channels/openai/routes.js';
import { registerChannelRoutes } from './channels/routes.js';
import type { Channels } from './channels/service.js';
import type { WhatsAppConnections } from './channels/whatsapp/connections.js';
import { registerCoordinationRoutes } from './coordination/routes.js';
import { Coordination } from './coordination/service.js';
import { registerDecisionRoutes } from './decisions/routes.js';
import { registerDeviceRoutes } from './devices/routes.js';
import { registerFileLinkRoutes } from './file-links/routes.js';
import { registerForwardRoutes } from './forwards/routes.js';
import { registerEventRoutes } from './http/events.js';
import { registerMetaRoutes } from './http/meta.js';
import { registerReturnPages } from './http/returned.js';
import { configureSecurity, isOwner } from './http/security.js';
import { registerPanelNotice } from './http/ui.js';
import type { GitHubIntegrations } from './integrations/github.js';
import { GitHubItems } from './integrations/github-items.js';
import { registerIntegrationRoutes } from './integrations/routes.js';
import type { XIntegration } from './integrations/x/integration.js';
import { registerXRoutes } from './integrations/x/routes.js';
import { registerMcpRoutes } from './mcp/routes.js';
import { registerMediaRoutes } from './media/routes.js';
import { registerMemoryRoutes } from './memories/routes.js';
import { registerPushRoutes } from './notifications/routes.js';
import { registerProfileRoutes } from './profiles/routes.js';
import { registerProjectRoutes } from './projects/routes.js';
import type { CodexLogin } from './providers/codex/login.js';
import type { ProviderModels } from './providers/discovery.js';
import { registerProviderRoutes } from './providers/routes.js';
import { registerReleaseRoutes } from './releases/routes.js';
import { registerRemoteRoutes } from './remote/routes.js';
import { registerReviewRoutes } from './reviews/routes.js';
import { PullReviews } from './reviews/service.js';
import { registerRunRoutes } from './runs/routes.js';
import { registerScheduleRoutes } from './schedules/routes.js';
import { registerSecretRoutes } from './secrets/routes.js';
import { registerSecurityRoutes } from './security/routes.js';
import type { Services } from './services.js';
import { registerSessionRoutes } from './sessions/routes.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { registerSkillRoutes } from './skills/routes.js';
import type { Skills } from './skills/service.js';
import { registerSshRoutes } from './ssh/routes.js';
import { registerStatsRoutes } from './stats/routes.js';
import type { Store } from './storage/database.js';
import { registerWorkRoutes } from './tasks/routes.js';
import { registerTelemetryRoutes } from './telemetry/routes.js';
import type { SpawnPty } from './terminals/pty.js';
import { registerTerminalRoutes } from './terminals/routes.js';
import { Terminals } from './terminals/service.js';
import { registerUpdateRoutes } from './updates/routes.js';
import { registerWebRoutes } from './web/routes.js';
import { registerWorktreeRoutes } from './worktrees/routes.js';

export function createApp(
  options: Services & {
    store: Store;
    token: string;
    /** The address phones reach this gateway at; a pairing QR code cannot be made without it. */
    publicUrl?: string;
    logger?: boolean;
    codexLogin?: CodexLogin;
    providerModels?: ProviderModels;
    skills?: Skills;
    github?: GitHubIntegrations;
    x?: XIntegration;
    channels?: Channels;
    whatsapp?: WhatsAppConnections;
    /** Absent without a public address: no MCP server can sign in with OAuth then. */
    mcpLogins?: McpLogins;
    /** `local` for the gateway a desktop app runs, which serves no panel notice of its own. */
    mode?: 'server' | 'local';
    maxStreams?: number;
    /** How long a quiet event stream waits before a heartbeat, in ms; tests shorten it. */
    heartbeatMs?: number;
    /** How long one event stream lasts before the client opens the next, in ms; tests shorten it. */
    streamLifetimeMs?: number;
    /** How long a stream's client may leave what it was sent unread, in ms; tests shorten it. */
    drainMs?: number;
    /** How long an ended stream may take to finish sending, in ms; tests shorten it. */
    lingerMs?: number;
    /** What starts a terminal's shell; tests pass one that starts no process. */
    spawnTerminal?: SpawnPty;
    /**
     * Who may set X-Forwarded-For and -Proto. The rate limits key on the address they name, and
     * the panel cookie is marked Secure from the scheme; trusting anyone else would let a client
     * pick both.
     */
    trustedProxies?: string[];
    /**
     * The guarded client every outbound call of the gateway goes through, with the private
     * origins the operator allowed. Absent, a request made from a route allows none.
     */
    fetcher?: typeof globalThis.fetch;
    onCancel?: (runId: string) => void;
  },
) {
  if (options.token.length < 32) {
    throw new Error('JIAN_API_TOKEN must have at least 32 characters');
  }

  const coordination = new Coordination(options);
  const terminals = new Terminals(options.spawnTerminal);

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body',
              'res.headers.set-cookie',
            ],
          },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true } },
    requestTimeout: 30000,
    connectionTimeout: 30000,
    bodyLimit: 256 * 1024,
    // A tool call's id is a path parameter, and a model's may be longer than Fastify's 100.
    routerOptions: { maxParamLength: MAX_PATH_PARAM },
    trustProxy: options.trustedProxies?.length ? options.trustedProxies : false,
    logController: new LogController({ disableRequestLogging: true }),
  });

  void app.register(helmet, {
    // A PDF attachment opens in the browser's reader from a local blob address.
    contentSecurityPolicy: {
      directives: { mediaSrc: ["'self'", 'data:'], frameSrc: ["'self'", 'blob:'] },
    },
  });
  // The limit guards the doors anyone can knock on. The owner and a paired phone are exempt:
  // the panel reaches the gateway through its own web server, so every tab shares one address,
  // and a chat that keeps its runs, timeline and agents current would otherwise lock its own
  // owner out. A phone does the same, and phones behind one NAT share a key.
  void app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    allowList: (request) => Boolean(request.device) || isOwner(request, options.token),
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header(
      'X-Robots-Tag',
      'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate',
    );
    return payload;
  });

  // Installed before any registrar runs, so every route below gets the contract's schema.
  app.addHook('onRoute', (route) => {
    const operation = operations.find(
      (item) => item.path === route.url && item.method === route.method,
    );

    if (operation) {
      const schema = operationSchema(operation);
      route.schema = { ...schema, response: withoutPropertyNames(schema.response) };
    }
  });

  configureSecurity(app, options);

  // A shell belongs to the gateway that shows it: none is left running behind a closed one.
  // Before the server stops taking requests, not after: a terminal's open stream is a request
  // in flight, and ending the shells is what ends it.
  app.addHook('preClose', async () => {
    options.forwards?.stop();
    await terminals.closeAll();
  });

  // The limiter attaches itself to each route as the route is added, and a plugin only loads
  // once the queue reaches it. Routes declared directly on `app` here would all be added before
  // it, unlimited; registering them as the next plugin puts them after it.
  void app.register(async (routes) => {
    registerProviderRoutes(routes, options);
    if (options.github) {
      registerIntegrationRoutes(
        routes,
        options.github,
        new GitHubItems(options.github, options.store),
        { webhook: options.mode !== 'local' },
      );
      // A webhook needs an address GitHub reaches: a desktop app's own gateway has none.
      if (options.mode !== 'local') {
        registerReviewRoutes(
          routes,
          new PullReviews(
            options.github,
            options.store,
            options.profiles,
            options.sessions,
            options.runs,
          ),
        );
      }
    }
    if (options.x) registerXRoutes(routes, options.x);
    registerMetaRoutes(routes, options.mode ?? 'server');
    registerSecurityRoutes(routes, options);
    registerDeviceRoutes(routes, options);
    registerSshRoutes(routes, options);
    registerSecretRoutes(routes, options);
    registerPushRoutes(routes, options);
    registerRemoteRoutes(routes, options);
    registerForwardRoutes(routes, options);
    registerSkillRoutes(routes, options);
    registerMcpRoutes(routes, options);
    registerProfileRoutes(routes, options);
    registerProjectRoutes(routes, options.projects);
    registerSessionRoutes(routes, { ...options, coordination });
    registerArtifactRoutes(routes, options);
    registerFileLinkRoutes(routes, options);
    registerWorktreeRoutes(routes, options);
    registerTerminalRoutes(routes, { ...options, terminals });
    registerMemoryRoutes(routes, options);
    registerStatsRoutes(routes, options);
    registerScheduleRoutes(routes, options);
    registerWorkRoutes(routes, options);
    registerSettingsRoutes(routes, options);
    registerTelemetryRoutes(routes, options);
    registerMediaRoutes(routes, options);
    registerRunRoutes(routes, options);
    registerCoordinationRoutes(routes, { coordination });
    registerChannelRoutes(routes, options);
    registerOpenAiRoutes(routes, options);
    registerWebRoutes(routes, options);
    registerReleaseRoutes(routes, options);
    registerUpdateRoutes(routes, options);
    registerDecisionRoutes(routes, options);

    registerEventRoutes(routes, options);

    // The server's panel moved to its own container; a desktop app's panel is the app itself.
    if (options.mode === 'local') registerReturnPages(routes);
    else registerPanelNotice(routes);
  });

  return app;
}

/**
 * A response schema without `propertyNames`: the serializer only writes, never checks keys, and
 * its strict Ajv warned at every start about the one a keyed record carries.
 */
export function withoutPropertyNames<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(withoutPropertyNames) as T;
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== 'propertyNames')
      .map(([key, value]) => [key, withoutPropertyNames(value)]),
  ) as T;
}
