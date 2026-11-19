import { panelUsageSchema } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import type { Settings } from '../settings/service.js';
import type { Store } from '../storage/database.js';
import { recordPanelUsage } from './panel-usage.js';

export function registerTelemetryRoutes(
  app: FastifyInstance,
  deps: { store: Store; settings: Settings },
) {
  // With the report off, by the owner or by the host, the counts are dropped here and never
  // kept: turning it back on starts from nothing. The answer is the same either way, so a panel
  // that has not read the setting yet does no harm.
  app.post('/v1/telemetry/panel-usage', async (request, reply) => {
    const usage = panelUsageSchema.parse(request.body);
    if ((await deps.settings.read()).telemetry?.enabled) {
      await recordPanelUsage(deps.store, usage);
    }
    return reply.code(204).send();
  });
}
