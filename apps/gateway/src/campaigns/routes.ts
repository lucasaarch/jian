import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { SalesCampaigns } from './service.js';

type CampaignParams = ProfileParams & { campaignId: string };

export function registerSalesCampaignRoutes(app: FastifyInstance, campaigns: SalesCampaigns): void {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/campaigns', async (request) =>
    campaigns.list(request.params.profileId),
  );
  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/campaigns', async (request, reply) =>
    reply.code(201).send(await campaigns.create(request.params.profileId, request.body)),
  );
  app.patch<{ Params: CampaignParams }>(
    '/v1/profiles/:profileId/campaigns/:campaignId',
    async (request) =>
      campaigns.update(request.params.profileId, request.params.campaignId, request.body),
  );
  app.delete<{ Params: CampaignParams }>(
    '/v1/profiles/:profileId/campaigns/:campaignId',
    async (request) => campaigns.remove(request.params.profileId, request.params.campaignId),
  );
}
