import type { createJianClient } from '@jian/sdk';

/** The generated client, passed to each area so every call shares one fetch and one base URL. */
export type Client = ReturnType<typeof createJianClient>;

export const profile = (profileId: string) => ({ path: { profileId } });

export const channel = (profileId: string, channelId: string) => ({
  path: { profileId, channelId },
});
