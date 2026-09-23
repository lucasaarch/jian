import { createHash } from 'node:crypto';
import type { MCPClient } from '@ai-sdk/mcp';
import type { Run } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { connectMcp, type SecretReader } from './mcp-connect.js';
import type { McpOAuthProviders } from './types.js';

interface McpContext {
  vault: SecretReader | undefined;
  secrets: Set<string>;
  clients: MCPClient[];
  fetcher: typeof globalThis.fetch;
  signal: AbortSignal;
  /** Absent in a gateway without the OAuth store; a server needing it then fails to connect. */
  oauth?: McpOAuthProviders;
}

/**
 * The exposed name has to be unique across servers and legal as a tool name, and the hash is
 * what keeps two long names from colliding once they are truncated.
 *
 * The double underscore is not cosmetic. Anthropic's subscription billing reads a single
 * underscore after `mcp` as the signature of a third-party app and refuses the whole request
 * with "Third-party apps now draw from your extra usage"; `mcp__` is the form it accepts.
 */
function exposedName(server: string, tool: string): string {
  const suffix = createHash('sha256').update(tool).digest('hex').slice(0, 8);

  return `mcp__${server}_${tool.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 18)}_${suffix}`;
}

/** What a server answered with when it refused to open, short enough to put in a prompt. */
function connectionFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);

  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Discover what each server offers now; expose a full schema only when the agent selects it. */
export async function connectMcpTools(run: Run, tools: ToolSet, context: McpContext) {
  const mcpToolNames: string[] = [];
  const selectedMcpTools = new Set<string>();
  const unavailable: Array<{ name: string; reason: string }> = [];

  for (const config of run.profile.mcpServers) {
    // A server whose token expired must not take the run with it: the agent keeps its other
    // tools, and is told which server it cannot reach so it can say so instead of failing.
    try {
      const client = await connectMcp({
        profileId: run.profileId,
        server: config,
        vault: context.vault as SecretReader,
        fetcher: context.fetcher,
        signal: context.signal,
        ...(config.auth === 'oauth'
          ? { authProvider: context.oauth?.(run.profileId, config.name) }
          : {}),
      });

      context.clients.push(client);

      // Everything the server offers. A long catalog costs nothing per turn: only the tools the
      // agent has loaded are sent with a request, so a server with a hundred of them is no
      // heavier than one with three until they are used.
      for (const [name, remote] of Object.entries(await client.tools())) {
        tools[exposedName(config.name, name)] = remote;
        mcpToolNames.push(exposedName(config.name, name));
      }
    } catch (error) {
      context.signal.throwIfAborted();
      unavailable.push({ name: config.name, reason: connectionFailure(error) });
    }
  }

  if (mcpToolNames.length > 0) {
    tools.load_mcp_tools = tool({
      description: `Load MCP tools before calling them. Previously loaded tools stay available, up to 32 per turn. Available names: ${mcpToolNames.slice(0, 10).join(', ')}${mcpToolNames.length > 10 ? '. Use search_mcp_tools for the rest.' : ''}`,
      inputSchema: z.object({ names: z.array(z.string()).min(1).max(10) }),
      execute: async ({ names }) => {
        if (names.some((name) => !mcpToolNames.includes(name))) {
          throw new Error('No connected MCP server offers that tool');
        }

        for (const name of names) {
          selectedMcpTools.delete(name);
          selectedMcpTools.add(name);
        }

        // Switching between two servers must not evict and reload the same schemas each step.
        // Bound the working set so discovery cannot eventually load the whole catalog.
        while (selectedMcpTools.size > 32) {
          selectedMcpTools.delete(selectedMcpTools.values().next().value as string);
        }

        return { selected: [...selectedMcpTools] };
      },
    });
  }

  if (mcpToolNames.length > 10) {
    tools.search_mcp_tools = tool({
      description:
        'Search the connected MCP servers by tool name or description. Load chosen names with load_mcp_tools.',
      inputSchema: z.object({ query: z.string().min(1).max(100) }),
      execute: async ({ query }) =>
        mcpToolNames
          .filter((name) =>
            `${name} ${tools[name]?.description ?? ''}`.toLowerCase().includes(query.toLowerCase()),
          )
          .slice(0, 10)
          .map((name) => {
            const description = tools[name]?.description;

            return {
              name,
              description: typeof description === 'string' ? description.slice(0, 300) : undefined,
            };
          }),
    });
  }

  return { mcpToolNames, selectedMcpTools, unavailable };
}

/**
 * Told to the agent rather than logged alone: without it the agent would report the work as
 * done, having silently lost the tools that were supposed to do it.
 */
export function unavailableNote(unavailable: Array<{ name: string; reason: string }>): string {
  if (unavailable.length === 0) {
    return '';
  }

  const list = unavailable.map((item) => `- ${item.name}: ${item.reason}`).join('\n');

  return (
    'These MCP servers could not be reached for this run, and none of their tools are ' +
    `available:\n${list}\n` +
    'Do not pretend to have used them. If the request needs one, say which server is ' +
    'unavailable and that the owner has to check its credentials.'
  );
}
