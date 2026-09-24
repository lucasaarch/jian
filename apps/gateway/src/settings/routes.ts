import type { FastifyInstance } from 'fastify';
import type { Settings } from './service.js';

export function registerSettingsRoutes(app: FastifyInstance, deps: { settings: Settings }) {
  app.get('/v1/settings', async () => deps.settings.read());
  app.put('/v1/settings', async (request) => deps.settings.update(request.body));
}
