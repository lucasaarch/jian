/**
 * What one MCP server can make this process hold or do, whatever it sends. The SDK reads a
 * response whole, or event by event, with no limit, and starts its OAuth requests with no signal,
 * so the limits live in the fetch it is given.
 */

const MB = 1024 * 1024;

export const MCP_LIMITS = {
  /**
   * The largest single message, in bytes. Real `tools/list` answers are at most a few MB; the
   * room above that is for a tool's result, such as a file or a screenshot in base64.
   */
  messageBytes: 64 * MB,
  /** How long a request the SDK sent with no signal of its own may take, in ms: its OAuth. */
  unsignalledMs: 30_000,
  /** Answers to the server's own requests in flight at once. Past it they are not sent. */
  replies: 8,
  /** How long the server has to take one of those answers, in ms. */
  replyMs: 10_000,
};

export type McpLimits = typeof MCP_LIMITS;

/** Read as an uncertain outcome (`mcp-errors.ts`): the server acted, and its answer was cut. */
const tooLarge = (limits: McpLimits) =>
  `MCP response too large: the server sent a message over ${Math.round(limits.messageBytes / MB)} MB`;

type RpcShape = { id?: string | number; reply: boolean };

/** Which JSON-RPC message a request carries, for the two cases treated apart. */
function rpcOf(body: unknown): RpcShape {
  if (typeof body !== 'string') return { reply: false };
  try {
    const message = JSON.parse(body) as { id?: unknown; method?: unknown };
    const id =
      typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
    return {
      ...(id === undefined ? {} : { id }),
      reply: id !== undefined && message.method === undefined,
    };
  } catch {
    return { reply: false };
  }
}

const LF = 10;
const CR = 13;

/**
 * Whether an event has passed `limit` bytes. An event ends at a blank line, in any of the three
 * line endings SSE allows, so a stream may run for ever as long as each event is a sane size.
 */
function eventMeter(limit: number) {
  let event = 0;
  let atLineStart = true;
  let previous = 0;

  return (chunk: Uint8Array): boolean => {
    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index] as number;
      const secondHalf = byte === LF && previous === CR;
      previous = byte;
      if (secondHalf) continue;
      if (byte === LF || byte === CR) {
        if (atLineStart) event = 0;
        atLineStart = true;
      } else {
        atLineStart = false;
        event += 1;
        if (event > limit) return true;
      }
    }
    return false;
  };
}

/** The response with its body held to the limits; status, headers and address unchanged. */
function bounded(
  response: Response,
  method: string,
  id: string | number | undefined,
  limits: McpLimits,
): Response {
  if (!response.body) return response;

  const stream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  const overEvent = eventMeter(limits.messageBytes);
  const said = tooLarge(limits);
  let total = 0;

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!stream) {
          total += chunk.byteLength;
          if (total > limits.messageBytes) controller.error(new Error(said));
          else controller.enqueue(chunk);
          return;
        }

        if (!overEvent(chunk)) {
          controller.enqueue(chunk);
          return;
        }

        // Erroring an event stream would leave the request behind it waiting, since the SDK
        // only logs that, and would make it reconnect a GET. The request is answered instead,
        // and the stream ends cleanly, which the SDK does not retry.
        if (method !== 'GET' && id !== undefined) {
          const error = { jsonrpc: '2.0', id, error: { code: -32000, message: said } };
          controller.enqueue(new TextEncoder().encode(`\n\ndata: ${JSON.stringify(error)}\n\n`));
        }
        controller.terminate();
      },
    }),
  );
  const held = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  Object.defineProperty(held, 'url', { value: response.url });

  return held;
}

/**
 * A fetch for one MCP server, held to `limits`. Answers to the server's own requests (a ping, a
 * refused elicitation) are the one thing it can make the gateway send as fast as it likes, each
 * on a socket of its own: at most a few go out at once, and the rest are dropped, as nothing
 * here waits for them.
 */
export function boundedMcpFetch(
  fetcher: typeof globalThis.fetch,
  limits: McpLimits = MCP_LIMITS,
): typeof globalThis.fetch {
  let replying = 0;

  return async (input, init) => {
    const { id, reply } = rpcOf(init?.body);

    if (reply) {
      if (replying >= limits.replies) return new Response(null, { status: 202 });
      replying += 1;
      try {
        const deadline = AbortSignal.timeout(limits.replyMs);
        const answered = await fetcher(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
        });
        await answered.body?.cancel().catch(() => {});
        return new Response(null, { status: 202 });
      } finally {
        replying -= 1;
      }
    }

    const response = await fetcher(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(limits.unsignalledMs),
    });

    return bounded(response, init?.method ?? 'GET', id, limits);
  };
}
