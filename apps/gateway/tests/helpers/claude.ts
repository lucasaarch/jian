import { createAnthropic } from '@ai-sdk/anthropic';

/** What the fake answers one request with: a tool call, or text that ends the turn. */
export type ClaudeReply = { tool: string; input?: unknown } | { text: string };

/** The parts of a Messages API request these tests read. */
export type ClaudeRequest = {
  stream?: boolean;
  tools?: Array<{ name: string; defer_loading?: boolean; cache_control?: unknown }>;
  messages: Array<{
    role: string;
    content:
      | string
      | Array<{
          type: string;
          tool_use_id?: string;
          is_error?: boolean;
          content?: string | Array<{ type: string; tool_name?: string; text?: string }>;
        }>;
  }>;
};

const event = (type: string, data: unknown) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

/**
 * The Anthropic provider the gateway really uses, pointed at a fake Messages API. The tests read
 * the JSON the provider would put on the wire, so what they check is what Anthropic would see
 * (`defer_loading`, `tool_reference`), not what the gateway handed the SDK. No request leaves
 * the process.
 */
export function fakeClaude(
  modelId: string,
  reply: (request: ClaudeRequest, index: number) => ClaudeReply,
) {
  const requests: ClaudeRequest[] = [];
  const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as ClaudeRequest;
    requests.push(request);
    const answer = reply(request, requests.length - 1);
    const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const block =
      'tool' in answer
        ? {
            type: 'tool_use',
            id: `toolu_${requests.length}`,
            name: answer.tool,
            input: answer.input ?? {},
          }
        : { type: 'text', text: answer.text };
    const stop = 'tool' in answer ? 'tool_use' : 'end_turn';

    if (!request.stream) {
      return Response.json({
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: [block],
        stop_reason: stop,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 5 },
      });
    }

    const body = [
      event('message_start', {
        message: { id: `msg_${requests.length}`, model: modelId, role: 'assistant', usage },
      }),
      'tool' in answer
        ? event('content_block_start', {
            index: 0,
            content_block: {
              type: 'tool_use',
              id: `toolu_${requests.length}`,
              name: answer.tool,
              input: {},
            },
          }) +
          event('content_block_delta', {
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(answer.input ?? {}) },
          })
        : event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
          event('content_block_delta', {
            index: 0,
            delta: { type: 'text_delta', text: answer.text },
          }),
      event('content_block_stop', { index: 0 }),
      event('message_delta', {
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 5 },
      }),
      event('message_stop', {}),
    ].join('');

    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };

  return {
    model: createAnthropic({ apiKey: 'sk-ant-test-synthetic', fetch })(modelId),
    requests,
  };
}

/** The tool definitions a request sent: name and whether it was deferred, in the order sent. */
export const sentTools = (request: ClaudeRequest | undefined) =>
  (request?.tools ?? []).map((item) => ({
    name: item.name,
    deferred: item.defer_loading === true,
  }));

/** Every tool a request's tool results reference, in order. */
export const referencedIn = (request: ClaudeRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    typeof message.content === 'string'
      ? []
      : message.content.flatMap((part) =>
          part.type === 'tool_result' && Array.isArray(part.content)
            ? part.content.flatMap((item) =>
                item.type === 'tool_reference' && item.tool_name ? [item.tool_name] : [],
              )
            : [],
        ),
  );

/** The tool result a request carries for a call, by the id the fake gave it. */
export const resultOf = (request: ClaudeRequest | undefined, toolUseId: string) =>
  (request?.messages ?? [])
    .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
    .find((part) => part.type === 'tool_result' && part.tool_use_id === toolUseId);
