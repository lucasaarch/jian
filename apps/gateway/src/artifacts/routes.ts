import {
  artifactFrameParamsSchema,
  artifactFrameQuerySchema,
  publicArtifactParamsSchema,
  publicArtifactUnlockSchema,
  sessionArtifactVersionParamsSchema,
} from '@jian/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { ProfileParams, SessionParams } from '../http/params.js';
import { artifactFrame, artifactPolicy, publishedArtifact } from './document.js';
import { passCookie, passOf } from './password.js';
import { attachment } from './public-files.js';
import { lockedPage } from './public-page.js';
import type { SessionArtifacts } from './service.js';

type ArtifactParams = SessionParams & { artifactId: string };
type FolderParams = ProfileParams & { folderId: string };

/**
 * An edited page is at most `SESSION_ARTIFACT_MAX` characters, which in JSON and UTF-8 can be
 * several times as many bytes: more than the gateway's default body takes.
 */
const EDIT_BODY_LIMIT = 2 * 1024 * 1024;

const html = (reply: FastifyReply, ancestors: "'self'" | "'none'", publicPage = false) =>
  reply
    .type('text/html; charset=utf-8')
    // Over the policy the gateway gives every answer, which would let the page reach its origin.
    .header('Content-Security-Policy', artifactPolicy(ancestors, publicPage));

/**
 * What a link with a password answers until it is given: a page that runs nothing and posts its
 * form back to the link alone, never kept, and never inside another site's page.
 */
const locked = (reply: FastifyReply, wrong = false) =>
  reply
    .code(401)
    .type('text/html; charset=utf-8')
    .header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    )
    .header('Cache-Control', 'no-store')
    .send(lockedPage({ wrong }));

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
  // a public link has no way to it, and neither has the frame, which holds no credential. A
  // public link has its own, for its latest version alone (`public-artifacts/:token/export`).
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

  // The owner's change to a deck's slides, by hand: as an edit, the panel's alone. An added slide
  // is a whole page, so it takes the same room.
  app.post<{ Params: ArtifactParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/artifacts/:artifactId/slides',
    { bodyLimit: EDIT_BODY_LIMIT },
    async (request, reply) => {
      if (request.device) {
        throw new GatewayError(403, 'A paired device cannot edit an Artifact.');
      }
      return reply
        .code(201)
        .send(
          await deps.artifacts.editSlides(
            request.params.profileId,
            request.params.sessionId,
            request.params.artifactId,
            request.body,
          ),
        );
    },
  );

  // Its name, its pin and its folder are how the owner keeps their page of them, which a paired
  // phone may do too. Making one public publishes it to anyone with the link, and its password
  // says which of them read it: both are the owner's alone, from the panel.
  app.patch<{ Params: ArtifactParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/artifacts/:artifactId',
    async (request) => {
      const asked = (request.body ?? {}) as { visibility?: unknown; password?: unknown };
      if (request.device && (asked.visibility !== undefined || asked.password !== undefined)) {
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

    // Helmet's Origin-Agent-Cluster is left off: Electron 45 dies on a CHECK when a sandboxed frame
    // it loads through its own scheme commits with it, and the desktop app loads this one so.
    return html(reply, "'self'")
      .removeHeader('Origin-Agent-Cluster')
      .header('Cache-Control', 'public, max-age=3600')
      .send(artifactFrame(type, edit === '1', present === '1', theme));
  });

  // Never kept, so a link stops answering the moment its Artifact is private again; and never
  // inside another site's page. One with a password answers its form until the reader's cookie
  // holds a pass to it.
  app.get('/v1/public-artifacts/:token', async (request, reply) => {
    const { token } = publicArtifactParamsSchema.parse(request.params);
    const found = await deps.artifacts.published(token, passOf(request.headers.cookie, token));
    if (found.locked) return locked(reply);

    return html(reply, "'none'", true)
      .header('Cache-Control', 'no-store')
      .send(
        publishedArtifact(found.type, found.title, found.source, {
          token,
          pass: found.pass,
          written: found.written,
        }),
      );
  });

  // The password, as the locked page's form posts it, and nothing else: encapsulated, so a form's
  // encoding is read on this route alone and no other is read here. The right one keeps a pass in
  // a cookie and sends the reader back to the link, by its own name so a gateway behind a path
  // still finds it; a wrong one, the form again.
  void app.register(async (form) => {
    form.removeAllContentTypeParsers();
    form.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 4096 },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
    form.post(
      '/v1/public-artifacts/:token',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const { token } = publicArtifactParamsSchema.parse(request.params);
        const { password } = publicArtifactUnlockSchema.parse(request.body);
        const pass = await deps.artifacts.unlock(token, password);
        if (pass === false) return locked(reply, true);
        if (pass) reply.header('Set-Cookie', passCookie(token, pass, request.protocol === 'https'));

        return reply.code(303).header('Location', token).send();
      },
    );
  });

  // A file of the same latest version, for the page's Download menu, by the same proof and kept
  // no more than the page. Always an attachment, and under a policy that runs nothing, so a
  // source that is itself a page (HTML) is saved, never drawn at the gateway's address.
  app.get('/v1/public-artifacts/:token/export', async (request, reply) => {
    const { token } = publicArtifactParamsSchema.parse(request.params);
    const file = await deps.artifacts.publicFile(
      token,
      request.query,
      passOf(request.headers.cookie, token),
    );

    return reply
      .type(file.mimeType)
      .header('Content-Disposition', attachment(file.title, file.format))
      .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store')
      .send(file.data);
  });
}
