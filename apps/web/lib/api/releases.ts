import type { Client } from './params';
import { result } from './result';

export const releaseCalls = (client: Client) => ({
  releases: () => result(client.GET('/v1/releases')),
  markReleasesSeen: () => result(client.POST('/v1/releases/seen')),
  repository: () => result(client.GET('/v1/repository')),
});
