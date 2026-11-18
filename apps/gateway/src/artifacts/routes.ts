import {
  artifactFrameParamsSchema,
  artifactFrameQuerySchema,
  publicArtifactParamsSchema,
  sessionArtifactVersionParamsSchema,
} from '@jian/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { SessionParams } from '../http/params.js';
import { artifactFrame, artifactPolicy, publishedArtifact } from './document.js';
import type { SessionArtifacts } from './service.js';

type ArtifactParams = SessionParams & { artifactId: string };

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

  app.patch<{ Params: ArtifactParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/artifacts/:artifactId',
    async (request) =>
      deps.artifacts.setVisibility(
        request.params.profileId,
        request.params.sessionId,
        request.params.artifactId,
        request.body,
      ),
  );

  // The frame holds no Artifact, so it needs no proof and may be kept: the panel, which read the
  // source with the owner's own credential, hands it over once the frame has loaded. Only the
  // panel may hold the frame, and the panel is served from the gateway's own address.
  app.get('/v1/artifact-frames/:type', async (request, reply) => {
    const { type } = artifactFrameParamsSchema.parse(request.params);
    const { edit } = artifactFrameQuerySchema.parse(request.query);

    return html(reply, "'self'")
      .header('Cache-Control', 'public, max-age=3600')
      .send(artifactFrame(type, edit === '1'));
  });

  // Never kept, so a link stops answering the moment its Artifact is private again; and never
  // inside another site's page.
  app.get('/v1/public-artifacts/:token', async (request, reply) => {
    const { token } = publicArtifactParamsSchema.parse(request.params);
    const { type, title, source } = await deps.artifacts.published(token);

    return html(reply, "'none'")
      .header('Cache-Control', 'no-store')
      .send(publishedArtifact(type, title, source));
  });
}
