import type { FastifyInstance } from 'fastify';
import { professionCatalog } from './catalog.js';

export function registerProfessionRoutes(app: FastifyInstance): void {
  // Read-only planning surface. No assignment/classification endpoint until enforcement ships.
  app.get('/v1/professions', async () => ({ assignable: false, professions: professionCatalog }));
}
