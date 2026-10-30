import type { FastifyInstance } from 'fastify';
import type { PushNotifications } from './push.js';

export function registerPushRoutes(app: FastifyInstance, deps: { push: PushNotifications }) {
  app.get('/v1/push/key', async () => deps.push.publicKey());

  app.put('/v1/push/subscriptions', async (request) => deps.push.subscribe(request.body));

  app.post('/v1/push/subscriptions/remove', async (request) => deps.push.unsubscribe(request.body));
}
