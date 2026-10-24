import { type Client, profile } from './params';
import { result } from './result';
import type { SalesCampaignInput } from './types';

export const campaignCalls = (client: Client) => ({
  campaigns: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/campaigns', { params: profile(profileId) })),
  createCampaign: (profileId: string, body: SalesCampaignInput) =>
    result(client.POST('/v1/profiles/{profileId}/campaigns', { params: profile(profileId), body })),
  updateCampaign: (profileId: string, campaignId: string, body: SalesCampaignInput) =>
    result(
      client.PATCH('/v1/profiles/{profileId}/campaigns/{campaignId}', {
        params: { path: { profileId, campaignId } },
        body,
      }),
    ),
  deleteCampaign: (profileId: string, campaignId: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/campaigns/{campaignId}', {
        params: { path: { profileId, campaignId } },
      }),
    ),
});
