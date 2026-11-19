import {
  artifactFrameParamsSchema,
  artifactFrameQuerySchema,
  publicArtifactParamsSchema,
  sessionArtifactVersionParamsSchema,
} from '@jian/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { ProfileParams, SessionParams } from '../http/params.js';
import { artifactFrame, artifactPolicy, publishedArtifact } from './document.js';
import type { SessionArtifacts } from './service.js';

type ArtifactParams = SessionParams & { artifactId: string };
type FolderParams = ProfileParams & { folderId: string };

/**
 * An edited page is at most `SESSION_ARTIFACT_MAX` characters, which in JSON and UTF-8 can be
 * several times as many bytes: more than the gateway's default body takes.
 */
const EDIT_BODY_LIMIT = 2 * 1024 * 1024;

const html = (reply: FastifyReply, ancestors: "'self'" | "'none'") =>
  reply
    .type('text/html; charset=utf-8')
    // Over the policy the gateway gives every answer, which would let the page reach its origin.
    .header('Content-Security-Policy', artifactPolicy(ancestors));

export function registerArtifactRoutes(
  app: FastifyInstance,
  deps: { artifacts: SessionArtifacts },
): void {
  // Every Artifact of the agent, for the panel's page of them. Its address is not `artifacts`,
  // which at this level reads a stored tool result.
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/session-artifacts', async (request) =>
    deps.artifacts.listAll(request.params.profileId, request.query),
  );

  app.get<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/artifacts',
    async (request) => deps.artifacts.list(request.params.profileId, request.params.sessionId),
  );

  app.get(
    '/v1/profiles/:profileId/sessions/:sessionId/artifacts/:artifactId/versions/:version',
    async (request) => {
      const params = sessionArtifactVersionParamsSchema.parse(request.params);

      return deps.artifacts.version(
        params.profileId,
        params.sessionId,
        params.artifactId,
        params.version,
      );
    },
  );

  // A deck's version drawn into a file. It reads, so a paired phone may ask as the owner does;
  // a public link has no way to it, and neither has the frame, which holds no credential.
  app.get(
    '/v1/profiles/:profileId/sessions/:sessionId/artifacts/:artifactId/versions/:version/export',
    async (request) => {
      const params = sessionArtifactVersionParamsSchema.parse(request.params);

      return deps.artifacts.export(
        params.profileId,
        params.sessionId,
        params.artifactId,
        params.version,
        request.query,
      );
    },
  );

  // The owner's edit by hand, saved by the panel as a new version. It asks for the owner's
  // credential like every route of a conversation: the frame the edit was made in has none and
  // reaches nothing, and a public link only reads. A paired phone only reads too: the owner
  // decided editing by hand belongs to the panel, on a browser or the desktop app.
  app.post<{ Params: ArtifactParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/artifacts/:artifactId/versions',
    { bodyLimit: EDIT_BODY_LIMIT },
    async (request, reply) => {
      if (request.device) {
        throw new GatewayError(403, 'A paired device cannot edit an Artifact.');
      }
      return reply
        .code(201)
        .send(
          await deps.artifacts.edit(
            request.params.profileId,
            request.params.sessionId,
            request.params.artifactId,
            request.body,
          ),
        );
    },
  );

  // Its name, its pin and its folder are how the owner keeps their page of them, which a paired
  // phone may do too. Making one public publishes it to anyone with the link: that is the
  // owner's alone, from the panel, in the same request or any other.
  app.patch<{ Params: ArtifactParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/artifacts/:artifactId',
    async (request) => {
      const asked = (request.body ?? {}) as { visibility?: unknown };
      if (request.device && asked.visibility !== undefined) {
        throw new GatewayError(403, 'A paired device cannot change who sees an Artifact.');
      }

      return deps.artifacts.update(
        request.params.profileId,
        request.params.sessionId,
        request.params.artifactId,
        request.body,
      );
    },
  );

  app.post<{ Params: ArtifactParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/artifacts/:artifactId/duplicate',
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await deps.artifacts.duplicate(
            request.params.profileId,
            request.params.sessionId,
            request.params.artifactId,
          ),
        ),
  );

  // Folders are how the owner keeps them, from the panel or a paired phone alike.
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/artifact-folders', async (request) =>
    deps.artifacts.folders(request.params.profileId),
  );

  app.post<{ Params: ProfileParams }>(
    '/v1/profiles/:profileId/artifact-folders',
    async (request, reply) =>
      reply
        .code(201)
        .send(await deps.artifacts.createFolder(request.params.profileId, request.body)),
  );

  app.patch<{ Params: FolderParams }>(
    '/v1/profiles/:profileId/artifact-folders/:folderId',
    async (request) =>
      deps.artifacts.renameFolder(request.params.profileId, request.params.folderId, request.body),
  );

  app.delete<{ Params: FolderParams }>(
    '/v1/profiles/:profileId/artifact-folders/:folderId',
    async (request, reply) => {
      await deps.artifacts.deleteFolder(request.params.profileId, request.params.folderId);

      return reply.code(204).send();
    },
  );

  // Removing one is the owner's from a paired phone too: only editing one by hand is not.
  app.delete<{ Params: ArtifactParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/artifacts/:artifactId',
    async (request, reply) => {
      await deps.artifacts.delete(
        request.params.profileId,
        request.params.sessionId,
        request.params.artifactId,
      );

      return reply.code(204).send();
    },
  );

  // The frame holds no Artifact, so it needs no proof and may be kept: the panel, which read the
  // source with the owner's own credential, hands it over once the frame has loaded. Only the
  // panel may hold the frame, and the panel is served from the gateway's own address.
  app.get('/v1/artifact-frames/:type', async (request, reply) => {
    const { type } = artifactFrameParamsSchema.parse(request.params);
    const { edit, present, theme } = artifactFrameQuerySchema.parse(request.query);

    return html(reply, "'self'")
      .header('Cache-Control', 'public, max-age=3600')
      .send(artifactFrame(type, edit === '1', present === '1', theme));
  });

  // Never kept, so a link stops answering the moment its Artifact is private again; and never
  // inside another site's page.
  app.get('/v1/public-artifacts/:token', async (request, reply) => {
    const { token } = publicArtifactParamsSchema.parse(request.params);
    const found = await deps.artifacts.published(token);

    return html(reply, "'none'")
      .header('Cache-Control', 'no-store')
      .send(publishedArtifact(found.type, found.title, found.source));
  });
}
