import { channelPatchSchema, contactPatchSchema } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { ChannelParams, ContactParams, ProfileParams, SessionParams } from '../http/params.js';
import type { Channels } from './service.js';
import type { WhatsAppConnections } from './whatsapp/connections.js';

type ChannelRouteServices = {
  channels?: Channels;
  whatsapp?: WhatsAppConnections;
};

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRouteServices): void {
  function channels() {
    if (!deps.channels) {
      throw new GatewayError(503, 'Channels are not configured');
    }

    return deps.channels;
  }

  function linkedDevices() {
    if (!deps.whatsapp) {
      throw new GatewayError(503, 'WhatsApp connections are not configured');
    }

    return deps.whatsapp;
  }

  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/channels', async (request, reply) =>
    reply.code(201).send(
      // HTTPS regardless of how the request arrived: Telegram accepts no other webhook, and
      // a TLS-terminating proxy keeps the host while dropping the scheme.
      await channels().connect(request.params.profileId, request.body, `https://${request.host}`),
    ),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/channels', async (request) =>
    channels().list(request.params.profileId),
  );

  app.patch<{ Params: ChannelParams }>(
    '/v1/profiles/:profileId/channels/:channelId',
    {
      // Do not let the global AJV coercion turn a string into an authorization setting.
      preValidation: async (request) => {
        channelPatchSchema.parse(request.body);
      },
    },
    async (request) =>
      channels().update(request.params.profileId, request.params.channelId, request.body),
  );

  app.delete<{ Params: ChannelParams }>(
    '/v1/profiles/:profileId/channels/:channelId',
    async (request) => channels().revoke(request.params.profileId, request.params.channelId),
  );

  app.get('/v1/groups', async () => channels().groups());

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/deliveries', async (request) =>
    channels().deliveries(request.params.profileId),
  );

  app.get<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/people',
    async (request) => channels().sessionPeople(request.params.profileId, request.params.sessionId),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/contacts', async (request) =>
    channels().contacts(request.params.profileId),
  );

  app.patch<{ Params: ProfileParams & { id: string } }>(
    '/v1/profiles/:profileId/contacts/:id',
    {
      // Validate before AJV can coerce strings into an automation setting.
      preValidation: async (request) => {
        contactPatchSchema.parse(request.body);
      },
    },
    async (request) =>
      channels().updateContact(request.params.profileId, request.params.id, request.body),
  );

  app.post<{ Params: ContactParams }>(
    '/v1/profiles/:profileId/contacts/:contactId/approve',
    async (request) =>
      channels().approveContact(request.params.profileId, request.params.contactId),
  );

  app.post<{ Params: ContactParams }>(
    '/v1/profiles/:profileId/contacts/:contactId/block',
    async (request) => channels().blockContact(request.params.profileId, request.params.contactId),
  );

  app.post<{ Params: ChannelParams }>(
    '/v1/profiles/:profileId/channels/:channelId/connect',
    async (request, reply) =>
      reply
        .code(202)
        .send(await linkedDevices().connect(request.params.profileId, request.params.channelId)),
  );

  app.get<{ Params: ChannelParams }>(
    '/v1/profiles/:profileId/channels/:channelId/connection',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return linkedDevices().status(request.params.profileId, request.params.channelId);
    },
  );

  app.get<{ Params: ChannelParams }>(
    '/v1/profiles/:profileId/channels/:channelId/qr',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return linkedDevices().qr(request.params.profileId, request.params.channelId);
    },
  );

  app.post<{ Params: ChannelParams }>(
    '/v1/profiles/:profileId/channels/:channelId/disconnect',
    async (request, reply) =>
      reply
        .code(202)
        .send(await linkedDevices().disconnect(request.params.profileId, request.params.channelId)),
  );

  // Encapsulation keeps the raw parser and 3 MB ceiling off every other API route.
  void app.register(async (meta) => {
    meta.removeContentTypeParser('application/json');
    meta.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    meta.get<{ Params: { channelId: string } }>(
      '/v1/whatsapp-business/:channelId',
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store').type('text/plain');
        return channels().metaChallenge(request.params.channelId, request.query);
      },
    );
    meta.post<{ Params: { channelId: string } }>(
      '/v1/whatsapp-business/:channelId',
      { bodyLimit: 3 * 1024 * 1024 },
      async (request) => {
        if (!Buffer.isBuffer(request.body)) throw new GatewayError(400, 'Expected a JSON body');
        return channels().receiveMeta(
          request.params.channelId,
          request.body,
          request.headers['x-hub-signature-256'],
        );
      },
    );
  });

  app.post<{ Params: { channelId: string } }>('/v1/ingress/:channelId', async (request, reply) =>
    reply.code(202).send(
      await channels().receive(request.params.channelId, {
        type: 'api',
        headers: request.headers,
        payload: request.body,
      }),
    ),
  );

  app.post<{ Params: { channelId: string } }>('/v1/telegram/:channelId', async (request) =>
    channels().receive(request.params.channelId, {
      type: 'telegram',
      headers: request.headers,
      payload: request.body,
    }),
  );
}
