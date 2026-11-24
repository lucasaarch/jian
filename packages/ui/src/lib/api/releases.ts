import type { UpdateComponent, UpdateWebhookInput } from '@jian/contracts';
import type { Client } from './params';
import { result } from './result';

export const releaseCalls = (client: Client) => ({
  releases: () => result(client.GET('/v1/releases')),
  markReleasesSeen: () => result(client.POST('/v1/releases/seen')),
  releaseMedia: (file: string) =>
    result(client.GET('/v1/releases/media/{file}', { params: { path: { file } } })),
  repository: () => result(client.GET('/v1/repository')),
  /** Liveness, the release, and whether this is a server or a desktop app's own gateway. */
  health: () => result(client.GET('/health')),
  /** How this server installation updates itself, and what it last tried. */
  updateStatus: () => result(client.GET('/v1/updates')),
  /** The same, with GitHub read now rather than its answer kept from earlier. */
  checkForUpdates: () => result(client.POST('/v1/updates/check')),
  startUpdate: (version: string, confirmBackup: boolean) =>
    result(client.POST('/v1/updates', { body: { version, confirmBackup } })),
  saveUpdateWebhook: (component: UpdateComponent, body: UpdateWebhookInput) =>
    result(
      client.PUT('/v1/updates/webhooks/{component}', { params: { path: { component } }, body }),
    ),
  removeUpdateWebhook: (component: UpdateComponent) =>
    result(client.DELETE('/v1/updates/webhooks/{component}', { params: { path: { component } } })),
});
