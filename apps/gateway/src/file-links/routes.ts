import { fileLinkParamsSchema } from '@jian/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { byteRange, cacheControl, disposition, entityTag, typeOf } from './serve.js';
import type { FileLinks } from './service.js';

const PATH = '/v1/file-links/:token/:name';

/** On every answer, a refusal too: nothing served here is run, sniffed, framed or referred. */
const sealed = (reply: FastifyReply) =>
  reply
    .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox")
    .header('X-Content-Type-Options', 'nosniff')
    .header('Referrer-Policy', 'no-referrer');

/**
 * A linked file, to anyone holding its link. Every reason it does not answer is the same bare 404,
 * so a reader learns nothing of which links exist or why one stopped. The global rate limit holds
 * here as on every public route. HEAD answers the same headers without opening a stream, which
 * Fastify's own HEAD would read to the end only to throw away.
 */
export function registerFileLinkRoutes(
  app: FastifyInstance,
  deps: { fileLinks?: FileLinks },
): void {
  const links = deps.fileLinks;
  // A gateway without an https:// public address, the desktop app's own among them, makes none.
  if (!links) return;

  const serve = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = fileLinkParamsSchema.safeParse(request.params);
    const link = parsed.success ? await links.open(parsed.data.token) : undefined;
    if (!link) {
      return sealed(reply).code(404).header('Cache-Control', 'no-store').send({
        error: 'Not found',
      });
    }

    const type = typeOf(link.name);
    const tag = entityTag(link.bytes, link.modifiedMs);
    const ifRange = request.headers['if-range'];
    // A client resuming a download it began on another version gets the whole file instead.
    const asked = ifRange && ifRange !== tag ? undefined : request.headers.range;
    const range = byteRange(asked, link.bytes);

    sealed(reply)
      .header('Accept-Ranges', 'bytes')
      .header('ETag', tag)
      .header('Last-Modified', new Date(link.modifiedMs).toUTCString())
      .header('Cache-Control', cacheControl(link.expiresAt, link.checkedAt))
      // The link is public by design: a service may show the picture or play the video from its
      // own page, which the gateway's default same-origin policy would block.
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('Content-Disposition', disposition(link.name, type));

    if (range === 'unsatisfiable') {
      await link.handle.close();
      return reply.code(416).header('Content-Range', `bytes */${link.bytes}`).send();
    }

    const { start, end } = range ?? { start: 0, end: link.bytes - 1 };
    reply
      .code(range ? 206 : 200)
      .type(type)
      .header('Content-Length', String(end - start + 1));
    if (range) reply.header('Content-Range', `bytes ${start}-${end}/${link.bytes}`);

    if (request.method === 'HEAD') {
      await link.handle.close();
      return reply.send();
    }
    // Closes the file when the stream ends, fails, or the reader goes away.
    return reply.send(link.handle.createReadStream({ start, end }));
  };

  app.get(PATH, { exposeHeadRoute: false }, serve);
  app.head(PATH, serve);
}
