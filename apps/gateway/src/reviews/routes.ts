import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { PullReviews } from './service.js';

type ItemParams = { owner: string; repo: string; number: number };

export function registerReviewRoutes(app: FastifyInstance, reviews: PullReviews) {
  app.get('/v1/integrations/github/pulls', (request) => reviews.list(request.query));

  app.post<{ Params: ItemParams }>(
    '/v1/integrations/github/pulls/:owner/:repo/:number/review',
    async (request, reply) =>
      reply.code(202).send(await reviews.start(request.params, request.body)),
  );

  app.get('/v1/integrations/github/reviews', () => reviews.status());
  app.put('/v1/integrations/github/reviews', (request) => reviews.save(request.body));
  app.post('/v1/integrations/github/reviews/webhook', () => reviews.setUpWebhook());

  // Encapsulated, so the raw parser stays off every other route: the signature is checked over
  // the bytes GitHub sent, never over JSON parsed and written again. GitHub caps a delivery's
  // payload at 25 MB, but a pull_request event is far smaller; 1 MiB keeps a forged one cheap.
  void app.register(async (raw) => {
    raw.removeContentTypeParser('application/json');
    raw.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    raw.post('/v1/integrations/github/webhook', async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) throw new GatewayError(400, 'Expected a JSON body');
      return reply.code(202).send(await reviews.receive(request.headers, request.body));
    });
  });
}
