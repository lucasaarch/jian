import type { McpServer, Run } from '@jian/contracts';

export interface ContextSource {
  /** `servers` are the MCP servers the run reaches; the skills it is offered follow them. */
  context(
    run: Run,
    servers: readonly McpServer[],
  ): Promise<{
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    currentStartIndex?: number;
    historyCursor?: { id: string; createdAt: string };
    /** The turn was judged plainly light, so it may be answered with less reasoning. */
    light?: true;
  }>;
}
