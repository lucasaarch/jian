import type { McpServer, Run, Skill } from '@jian/contracts';

export interface ContextSource {
  /** `servers` are the MCP servers the run reaches; the skills it is offered follow them. */
  context(
    run: Run,
    servers: readonly McpServer[],
    /** What the conversation's workspaces say: project instructions and skills. */
    project?: {
      sections: string[];
      skills: Skill[];
      /**
       * The run has worktree tools; `create` when it can also make one, `signals` when its turns
       * say who else works in its folders.
       */
      /**
       * The conversation targets a machine; `files` when this run's file tools work on it. A
       * worker's are the gateway's, so it is told apart by `files: false` and its own run.
       */
      machine?: { files: boolean };
      worktrees?: { create: boolean; machine: boolean; signals: boolean; files?: boolean };
    },
  ): Promise<{
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    currentStartIndex?: number;
    historyCursor?: { id: string; createdAt: string };
    /** The turn was judged plainly light, so it may be answered with less reasoning. */
    light?: true;
  }>;
}
