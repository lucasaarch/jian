import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { Devices } from './service.js';

/** The `/self` routes belong to the phone that made the request; the owner has no device. */
function selfOf(request: FastifyRequest): string {
  if (!request.device) {
    throw new GatewayError(404, 'This request was not made by a paired device.');
  }
  return request.device;
}

export function registerDeviceRoutes(
  app: FastifyInstance,
  deps: { devices: Devices; publicUrl?: string },
): void {
  const { devices } = deps;

  app.post('/v1/devices/pairings', async (_request, reply) =>
    reply.code(201).send(await devices.createPairing(deps.publicUrl)),
  );

  app.post(
    '/v1/devices/pair',
    // Tighter than the global ceiling: the code is the only proof, so guesses must be slow.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => reply.code(201).send(await devices.pair(request.body)),
  );

  app.get('/v1/devices', async () => devices.list());

  app.get('/v1/devices/self', async (request) => {
    const id = selfOf(request);
    const device = (await devices.list()).find((item) => item.id === id);
    if (!device) throw new GatewayError(404, 'Device not found');
    return device;
  });

  app.put('/v1/devices/self/push', async (request) =>
    devices.setPush(selfOf(request), request.body),
  );

  app.put('/v1/devices/self/focus', async (request, reply) => {
    await devices.setFocus(selfOf(request), request.body);
    return reply.code(204).send();
  });

  app.delete('/v1/devices/self', async (request, reply) => {
    await devices.revoke(selfOf(request));
    return reply.code(204).send();
  });

  app.patch<{ Params: { deviceId: string } }>('/v1/devices/:deviceId', async (request) =>
    devices.update(request.params.deviceId, request.body),
  );

  app.delete<{ Params: { deviceId: string } }>('/v1/devices/:deviceId', async (request, reply) => {
    await devices.revoke(request.params.deviceId);
    return reply.code(204).send();
  });
}
