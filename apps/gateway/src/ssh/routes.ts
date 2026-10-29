import type { FastifyInstance } from 'fastify';
import type { SshKeys } from './service.js';

export function registerSshRoutes(app: FastifyInstance, deps: { sshKeys: SshKeys }): void {
  app.get('/v1/ssh-keys', async () => deps.sshKeys.list());

  app.post('/v1/ssh-keys', async (request, reply) =>
    reply.code(201).send(await deps.sshKeys.create(request.body as never)),
  );

  app.delete<{ Params: { keyId: string } }>('/v1/ssh-keys/:keyId', async (request) =>
    deps.sshKeys.remove(request.params.keyId),
  );
}
