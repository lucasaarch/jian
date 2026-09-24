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

/** One tool a server offers, under the name the model calls and the name the server gave it. */
export type McpEntry = { name: string; server: string; tool: string; description: string };

/** Results per search: enough to choose from, few enough to keep the answer short. */
const SEARCH_RESULTS = 15;
/** Names per server spelled out in the prompt; a longer catalog is reached by searching. */
const PROMPT_NAMES = 60;

/**
 * Words as a person would type them: `createIssue`, `create_issue` and "Create issue" are the
 * same three words, and accents do not decide a match.
 */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}

/** A word matches its own plural, a prefix of four letters or more, and nothing shorter. */
function matches(candidate: string, word: string): boolean {
  if (candidate === word) {
    return true;
  }

  const [short, long] = candidate.length < word.length ? [candidate, word] : [word, candidate];

  return short.length >= 4 && long.startsWith(short);
}

/**
 * Ranks the catalog by how many of the query's words each tool carries — in its name first,
 * then its server, then its description — instead of requiring the query as one exact phrase.
 * A model asks in words ("create issue"); requiring `create_issue` verbatim is what made it
 * conclude a tool that exists did not.
 */
export function searchCatalog(catalog: McpEntry[], query: string, server?: string): McpEntry[] {
  const wanted = [...new Set(words(query))];
  const pool = server ? catalog.filter((entry) => entry.server === server) : catalog;

  if (wanted.length === 0) {
    return pool.slice(0, SEARCH_RESULTS);
  }

  return pool
    .map((entry, index) => {
      const fields = [
        { weight: 3, words: words(entry.tool) },
        { weight: 2, words: words(entry.server) },
        { weight: 1, words: words(entry.description) },
      ];
      const score = wanted.reduce(
        (total, word) =>
          total +
          Math.max(
            0,
            ...fields.map((field) =>
              field.words.some((candidate) => matches(candidate, word)) ? field.weight : 0,
            ),
          ),
        0,
      );

      return { entry, score, index };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, SEARCH_RESULTS)
    .map((item) => item.entry);
}

/**
 * Finds a catalog entry by the name the model has at hand: the exposed name, `server.tool`, or
 * the server's own tool name when only one server offers it. The prompt shows the servers' own
 * names, so refusing them would turn a correct request into "no such tool".
 */
function resolveEntry(catalog: McpEntry[], name: string): McpEntry | undefined {
  const exact = catalog.find((entry) => entry.name === name);

  if (exact) {
    return exact;
  }

  const qualified = catalog.find((entry) => `${entry.server}.${entry.tool}` === name);

  if (qualified) {
    return qualified;
  }

  const bare = catalog.filter((entry) => entry.tool === name);

  return bare.length === 1 ? bare[0] : undefined;
}

const brief = (entry: McpEntry) => ({
  name: entry.name,
  server: entry.server,
  tool: entry.tool,
  ...(entry.description ? { description: entry.description.slice(0, 300) } : {}),
});

/** Discover what each server offers now; expose a full schema only when the agent selects it. */
export async function connectMcpTools(run: Run, tools: ToolSet, context: McpContext) {
  const mcpToolNames: string[] = [];
  const catalog: McpEntry[] = [];
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
      const disabled = new Set(config.disabledTools ?? []);

      for (const [name, remote] of Object.entries(await client.tools())) {
        // Switched off by the owner: not callable, and not even findable, so the agent never
        // plans around a tool it would be refused.
        if (disabled.has(name)) continue;

        const exposed = exposedName(config.name, name);

        tools[exposed] = remote;
        mcpToolNames.push(exposed);
        catalog.push({
          name: exposed,
          server: config.name,
          tool: name,
          description:
            typeof remote.description === 'string'
              ? remote.description.replace(/\s+/g, ' ').trim()
              : '',
        });
      }
    } catch (error) {
      context.signal.throwIfAborted();
      unavailable.push({ name: config.name, reason: connectionFailure(error) });
    }
  }

  if (catalog.length > 0) {
    const servers = [...new Set(catalog.map((entry) => entry.server))];

    tools.load_mcp_tools = tool({
      description: `Load MCP tools before calling them; a loaded tool stays available for the rest of the turn, up to 32 at a time. Accepts the exposed name, server.tool, or the server's own tool name.${
        catalog.length <= 10
          ? ` Available: ${catalog.map((entry) => `${entry.name} (${entry.server}.${entry.tool})`).join(', ')}`
          : ' Find names with search_mcp_tools.'
      }`,
      inputSchema: z.object({ names: z.array(z.string()).min(1).max(10) }),
      execute: async ({ names }) => {
        const chosen = names.map((name) => ({ name, entry: resolveEntry(catalog, name) }));
        const unknown = chosen.filter((item) => !item.entry).map((item) => item.name);

        if (unknown.length > 0) {
          throw new Error(
            `No connected MCP server offers ${unknown.join(', ')}. Search with search_mcp_tools; connected servers: ${servers.join(', ')}`,
          );
        }

        for (const { entry } of chosen) {
          selectedMcpTools.delete((entry as McpEntry).name);
          selectedMcpTools.add((entry as McpEntry).name);
        }

        // Switching between two servers must not evict and reload the same schemas each step.
        // Bound the working set so discovery cannot eventually load the whole catalog.
        while (selectedMcpTools.size > 32) {
          selectedMcpTools.delete(selectedMcpTools.values().next().value as string);
        }

        return { selected: [...selectedMcpTools] };
      },
    });

    tools.search_mcp_tools = tool({
      description: `Find tools on the connected MCP servers (${servers.join(', ')}) by what they do, in a few words — "create issue", "send email". Matches names and descriptions word by word. Give a server alone to list its tools. Load what you choose with load_mcp_tools.`,
      inputSchema: z.object({
        query: z.string().max(200).default(''),
        server: z.enum(servers as [string, ...string[]]).optional(),
      }),
      execute: async ({ query, server }) => {
        const results = searchCatalog(catalog, query, server);

        return results.length > 0
          ? { results: results.map(brief) }
          : {
              results: [],
              hint: `Nothing matched. Try other words or the English terms, or list one server: ${servers
                .map(
                  (name) =>
                    `${name} (${catalog.filter((entry) => entry.server === name).length} tools)`,
                )
                .join(', ')}.`,
            };
      },
    });
  }

  return { mcpToolNames, selectedMcpTools, unavailable, catalog };
}

/**
 * The servers and what they offer, in the system prompt. Without it the agent learns that MCP
 * tools exist only from a loader's description, and answers "I have no tool for that" about a
 * tool it was given. Names only — descriptions are one search away and would cost every turn.
 */
export function availableNote(catalog: McpEntry[]): string {
  if (catalog.length === 0) {
    return '';
  }

  const servers = [...new Set(catalog.map((entry) => entry.server))].map((server) => {
    const names = catalog.filter((entry) => entry.server === server).map((entry) => entry.tool);
    const shown = names.slice(0, PROMPT_NAMES).join(', ');

    return `- ${server} (${names.length} tools): ${shown}${
      names.length > PROMPT_NAMES ? `, and ${names.length - PROMPT_NAMES} more` : ''
    }`;
  });

  return (
    'These MCP servers are connected for this run, and every tool they offer is yours to use:\n' +
    `${servers.join('\n')}\n` +
    'Their tools are not in your tool list until loaded: find one with search_mcp_tools and load ' +
    'it with load_mcp_tools. Before saying you cannot do something, search these servers for it.'
  );
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
