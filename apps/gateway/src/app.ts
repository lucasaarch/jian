import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { operationSchema, operations } from '@jian/contracts';
import Fastify, { LogController } from 'fastify';
import { registerChannelRoutes } from './channels/routes.js';
import type { Channels } from './channels/service.js';
import type { WhatsAppConnections } from './channels/whatsapp/connections.js';
import { registerCoordinationRoutes } from './coordination/routes.js';
import { Coordination } from './coordination/service.js';
import { registerDecisionRoutes } from './decisions/routes.js';
import { registerEventRoutes } from './http/events.js';
import { registerMetaRoutes } from './http/meta.js';
import { configureSecurity } from './http/security.js';
import { registerPanelNotice } from './http/ui.js';
import type { GitHubIntegrations } from './integrations/github.js';
import { registerIntegrationRoutes } from './integrations/routes.js';
import { registerMediaRoutes } from './media/routes.js';
import { registerMemoryRoutes } from './memories/routes.js';
import { registerProfileRoutes } from './profiles/routes.js';
import { registerProjectRoutes } from './projects/routes.js';
import type { CodexLogin } from './providers/codex/login.js';
import type { ProviderModels } from './providers/discovery.js';
import { registerProviderRoutes } from './providers/routes.js';
import { registerReleaseRoutes } from './releases/routes.js';
import { registerRemoteRoutes } from './remote/routes.js';
import { registerRunRoutes } from './runs/routes.js';
import { registerScheduleRoutes } from './schedules/routes.js';
import { registerSecurityRoutes } from './security/routes.js';
import type { Services } from './services.js';
import { registerSessionRoutes } from './sessions/routes.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { registerSkillRoutes } from './skills/routes.js';
import type { Skills } from './skills/service.js';
import { registerSshRoutes } from './ssh/routes.js';
import { registerStatsRoutes } from './stats/routes.js';
import { registerStickerRoutes } from './stickers/routes.js';
import type { Store } from './storage/database.js';
import { registerSubscriptionRoutes } from './subscriptions/routes.js';
import { registerWorkRoutes } from './tasks/routes.js';
import { registerWebRoutes } from './web/routes.js';

export function createApp(
  options: Services & {
    store: Store;
    token: string;
    logger?: boolean;
    codexLogin?: CodexLogin;
    providerModels?: ProviderModels;
    skills?: Skills;
    github?: GitHubIntegrations;
    channels?: Channels;
    whatsapp?: WhatsAppConnections;
    maxStreams?: number;
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
    trustProxy: options.trustedProxies?.length ? options.trustedProxies : false,
    logController: new LogController({ disableRequestLogging: true }),
  });

  void app.register(helmet, {
    // A PDF attachment opens in the browser's reader from a local blob address.
    contentSecurityPolicy: {
      directives: { mediaSrc: ["'self'", 'data:'], frameSrc: ["'self'", 'blob:'] },
    },
  });
  void app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

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
      route.schema = operationSchema(operation);
    }
  });

  configureSecurity(app, options);

  // The limiter attaches itself to each route as the route is added, and a plugin only loads
  // once the queue reaches it. Routes declared directly on `app` here would all be added before
  // it, unlimited; registering them as the next plugin puts them after it.
  void app.register(async (routes) => {
    registerProviderRoutes(routes, options);
    if (options.github) registerIntegrationRoutes(routes, options.github);
    registerMetaRoutes(routes);
    registerSecurityRoutes(routes, options);
    registerSshRoutes(routes, options);
    registerRemoteRoutes(routes, options);
    registerSkillRoutes(routes, options);
    registerProfileRoutes(routes, options);
    registerProjectRoutes(routes, options.projects);
    registerSessionRoutes(routes, { ...options, coordination });
    registerMemoryRoutes(routes, options);
    registerStickerRoutes(routes, options);
    registerStatsRoutes(routes, options);
    registerScheduleRoutes(routes, options);
    registerSubscriptionRoutes(routes, options);
    registerWorkRoutes(routes, options);
    registerSettingsRoutes(routes, options);
    registerMediaRoutes(routes, options);
    registerRunRoutes(routes, options);
    registerCoordinationRoutes(routes, { coordination });
    registerChannelRoutes(routes, options);
    registerWebRoutes(routes, options);
    registerReleaseRoutes(routes, options);
    registerDecisionRoutes(routes, options);

    registerEventRoutes(routes, options);

    registerPanelNotice(routes);
  });

  return app;
}
