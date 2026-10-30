import type { Socket } from 'node:net';
import {
  type ChatCompletionChunk,
  chatCompletionRequestSchema,
  ingressSchema,
  type OpenAiError,
} from '@jian/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { GatewayError } from '../../core/errors.js';
import type { Store } from '../../storage/database.js';
import type { Channels } from '../service.js';
import {
  ANSWER_WAIT_MS,
  type AnswerDeps,
  answerOf,
  StreamedText,
  settle,
  usageOf,
} from './answer.js';
import { openAiTurn } from './turn.js';

/**
 * The largest request body, in bytes. A client of this dialect resends the whole conversation
 * on every turn, so the gateway's usual 256 KB would refuse a long chat that is still healthy.
 */
const BODY_LIMIT = 4 * 1024 * 1024;

/** How often a quiet stream says it is alive, in ms: proxies close a silent one. */
const KEEPALIVE_MS = 15_000;

type Params = { Params: { channelId: string } };

const failures: Record<number, { type: string; code: string }> = {
  400: { type: 'invalid_request_error', code: 'invalid_request' },
  401: { type: 'invalid_request_error', code: 'invalid_api_key' },
  403: { type: 'permission_error', code: 'forbidden' },
  404: { type: 'invalid_request_error', code: 'not_found' },
  409: { type: 'invalid_request_error', code: 'conflict' },
  413: { type: 'invalid_request_error', code: 'request_too_large' },
  429: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
};

function failure(status: number, message: string): OpenAiError {
  const kind = failures[status] ?? { type: 'server_error', code: 'server_error' };

  return { error: { message, type: kind.type, code: kind.code } };
}

/** Every refusal in OpenAI's shape, because that is the only shape its clients read. */
function refusal(error: unknown): { status: number; body: OpenAiError } {
  if (error instanceof ZodError) {
    const message = error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');

    return { status: 400, body: failure(400, message) };
  }

  if (error instanceof GatewayError) {
    return { status: error.statusCode, body: failure(error.statusCode, error.message) };
  }

  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number(error.statusCode)
      : 500;

  // Fastify's own refusals (schema validation, body size, rate limit) word themselves.
  if (status >= 400 && status < 500) {
    const message = error instanceof Error && error.message ? error.message : 'Invalid request';

    return { status, body: failure(status, message) };
  }

  return { status: 500, body: failure(500, 'Internal server error') };
}

/** An OpenAI client sends its API key as a bearer; the channel's own header is taken too. */
function tokenOf(request: FastifyRequest): unknown {
  const authorization = request.headers.authorization;

  if (typeof authorization === 'string' && /^bearer /i.test(authorization)) {
    return authorization.slice(7).trim();
  }

  return request.headers['x-jian-channel-token'];
}

/** Why a message that was taken in started no run, as the client can act on it. */
function notStarted(result: Awaited<ReturnType<Channels['converse']>>): GatewayError {
  if (result.contact === 'pending') {
    return new GatewayError(
      403,
      'This conversation is waiting for the owner to approve it in Jian. Send the same request again once it is approved.',
    );
  }

  if (result.contact === 'blocked') {
    return new GatewayError(403, 'The owner blocked this conversation in Jian');
  }

  if (result.silence === 'no-model') {
    return new GatewayError(503, 'No AI model is set up in Jian yet. The owner can choose one.');
  }

  return new GatewayError(409, 'This conversation is paused in Jian');
}

/** The OpenAI Chat Completions API, served per API channel and authenticated by its token. */
export function registerOpenAiRoutes(
  app: FastifyInstance,
  deps: { channels?: Channels; runs: AnswerDeps['runs']; store: Store },
): void {
  function channels() {
    if (!deps.channels) throw new GatewayError(503, 'Channels are not configured');

    return deps.channels;
  }

  // Encapsulated so the OpenAI error shape stays on these routes alone.
  void app.register(async (door) => {
    door.setErrorHandler((error, request, reply) => {
      const { status, body } = refusal(error);

      if (status >= 500 && !(error instanceof GatewayError)) {
        request.log.error({ event: 'request.failed' }, 'Request failed');
      }

      return reply.code(status).send(body);
    });

    door.get<Params>('/v1/channels/:channelId/openai/models', async (request) => {
      const channel = await channels().apiChannel(request.params.channelId, tokenOf(request));
      const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
      const listed = new Set<string>();
      const models = (await channels().apiModels()).filter(({ model }) => {
        if (listed.has(model.id)) return false;
        listed.add(model.id);
        return true;
      });

      return {
        object: 'list',
        data: [
          { id: 'default', object: 'model', created: seconds(channel.createdAt), owned_by: 'jian' },
          ...models.map(({ provider, model }) => ({
            id: model.id,
            object: 'model',
            created: seconds(provider.createdAt),
            owned_by: provider.kind,
          })),
        ],
      };
    });

    door.post<Params>(
      '/v1/channels/:channelId/openai/chat/completions',
      { bodyLimit: BODY_LIMIT },
      async (request, reply) => {
        const channel = await channels().apiChannel(request.params.channelId, tokenOf(request));
        const body = chatCompletionRequestSchema.parse(request.body);
        const turn = openAiTurn(channel.id, body);
        const result = await channels().converse(
          channel,
          ingressSchema.parse({
            ...turn,
            model: body.model,
            ...(body.reasoning_effort ? { effort: body.reasoning_effort } : {}),
            ...(body.protection ? { protection: body.protection } : {}),
          }),
        );

        if (!result.runId) throw notStarted(result);

        const started = await deps.runs.run(channel.profileId, result.runId);
        const answer = {
          profileId: channel.profileId,
          runId: started.id,
          id: `chatcmpl-${started.id}`,
          created: Math.floor(Date.now() / 1000),
          model: started.modelSelection?.modelId ?? started.model?.modelId ?? body.model,
        };

        // The client may leave; the run does not stop with it, and the conversation in Jian
        // still gets its answer.
        const left = new AbortController();
        reply.raw.on('close', () => left.abort());
        // The server closes a socket idle for 30 seconds, and this one waits for an agent. An
        // injected request has no socket to set.
        const socket = request.raw.socket as Partial<Socket> | undefined;
        socket?.setTimeout?.(ANSWER_WAIT_MS + 60_000);

        if (body.stream) return stream(reply, deps, answer, left);

        const settled = await settle(deps, answer.profileId, answer.runId, left.signal);

        if (!settled) {
          throw new GatewayError(
            503,
            'The agent is still working. Its answer will be in the conversation in Jian; send the same request again to keep waiting for it.',
          );
        }

        const said = answerOf(settled);

        if ('failure' in said) throw new GatewayError(500, said.failure);

        return {
          id: answer.id,
          object: 'chat.completion',
          created: answer.created,
          model: answer.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: said.content },
              finish_reason: 'stop',
            },
          ],
          usage: usageOf(settled),
        };
      },
    );
  });
}

/**
 * The answer as OpenAI streams it: the role, the text as the run writes it, the stop, and
 * `[DONE]`. Once the stream has begun its status cannot change, so a failure is an `error`
 * event, which OpenAI's clients raise as one.
 */
async function stream(
  reply: FastifyReply,
  deps: AnswerDeps,
  answer: { profileId: string; runId: string; id: string; created: number; model: string },
  left: AbortController,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform keeps a compressing proxy, the web server's included, from holding events
    // back to fill a gzip block.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (line: string) => {
    if (!left.signal.aborted) reply.raw.write(line);
  };
  const send = (value: unknown) => write(`data: ${JSON.stringify(value)}\n\n`);
  const chunk = (
    delta: ChatCompletionChunk['choices'][number]['delta'],
    finish: 'stop' | null = null,
  ): ChatCompletionChunk => ({
    id: answer.id,
    object: 'chat.completion.chunk',
    created: answer.created,
    model: answer.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const text = new StreamedText();
  const keepalive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS);

  try {
    send(chunk({ role: 'assistant' }));

    const settled = await settle(deps, answer.profileId, answer.runId, left.signal, (run) => {
      if (!run.progress) return;

      const delta = text.next(run.progress.text);

      if (delta) send(chunk({ content: delta }));
    });

    if (left.signal.aborted) return;

    const said = settled
      ? answerOf(settled)
      : {
          failure:
            'The agent is still working. Its answer will be in the conversation in Jian; send the same request again to keep waiting for it.',
        };

    if ('failure' in said) {
      send(failure(settled ? 500 : 503, said.failure));
      return;
    }

    const rest = text.finish(said.content);

    if (rest) send(chunk({ content: rest }));
    send(chunk({}, 'stop'));
    write('data: [DONE]\n\n');
  } catch {
    send(failure(500, 'Internal server error'));
  } finally {
    clearInterval(keepalive);
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}
