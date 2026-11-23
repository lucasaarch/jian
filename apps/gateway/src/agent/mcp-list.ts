import type { MCPClient } from '@ai-sdk/mcp';

/**
 * How far one server's catalog may go. The SDK's own `tools()` follows `nextCursor` for as long
 * as a server hands one out, with no signal, so a broken server could hold a run for ever.
 */
export const MCP_LIST_LIMITS = {
  /** How long listing may take after connecting, in ms; slow paged catalogs fit in it. */
  ms: 30_000,
  /** Pages followed: real catalogs have a handful. */
  pages: 200,
  /** Tools from one server: Anthropic takes 10,000 deferred tools across all of them. */
  tools: 5_000,
  /** The catalog's size as JSON, in characters. The largest real ones are a few million. */
  chars: 32 * 1024 * 1024,
};

export type McpListLimits = typeof MCP_LIST_LIMITS;

type Listed = Awaited<ReturnType<MCPClient['listTools']>>;

/**
 * Every tool a server offers, page by page, within `limits`. Past one it throws what the owner
 * should read, and the server is reported unavailable for the turn. `signal` is the run's.
 */
export async function listAllTools(
  client: MCPClient,
  signal?: AbortSignal,
  limits: McpListLimits = MCP_LIST_LIMITS,
) {
  const deadline = AbortSignal.timeout(limits.ms);
  const options = { signal: signal ? AbortSignal.any([signal, deadline]) : deadline };
  const seen = new Set<string>();
  const tools: Listed['tools'][number][] = [];
  let chars = 0;

  try {
    let page = await client.listTools({ options });

    for (let count = 1; ; count += 1) {
      for (const tool of page.tools) tools.push(tool);
      chars += JSON.stringify(page.tools).length;

      if (tools.length > limits.tools) {
        throw new Error(`The server lists more than ${limits.tools} tools`);
      }
      if (chars > limits.chars) {
        throw new Error('The server lists a tool catalog too large to load');
      }

      // An empty cursor is how some servers say there is no next page.
      const cursor = page.nextCursor;
      if (!cursor) return client.toolsFromDefinitions({ ...page, tools });

      if (seen.has(cursor)) {
        throw new Error('The server repeats a page of its tool list');
      }
      if (count >= limits.pages) {
        throw new Error(`The server lists more than ${limits.pages} pages of tools`);
      }
      seen.add(cursor);
      page = await client.listTools({ params: { cursor }, options });
    }
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) {
      throw new Error(`The server did not list its tools within ${limits.ms / 1000} s`);
    }
    throw error;
  }
}
