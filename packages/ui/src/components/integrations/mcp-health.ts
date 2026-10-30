import type { McpStatus } from '../../lib/api';

export type McpHealthTone = 'neutral' | 'good' | 'warn' | 'bad';

/**
 * How a saved server stands after its last check, in a word and a tone; nothing before the owner
 * asks. A connected server also counts the tools its agents are offered, out of all it has.
 */
export function mcpHealth(
  check: { status?: McpStatus; error: string; busy: boolean },
  disabledTools: string[],
): { label: string; tone: McpHealthTone; tools?: string } | undefined {
  const { status, error, busy } = check;

  if (busy) return { label: 'Checking…', tone: 'neutral' };
  if (error) return { label: 'Check failed', tone: 'bad' };
  if (status?.reachable) {
    const on = status.tools.filter((tool) => !disabledTools.includes(tool.name)).length;
    const of = on < status.tools.length ? ` of ${status.tools.length}` : '';

    return { label: 'Connected', tone: 'good', tools: `${on} ${on === 1 ? 'tool' : 'tools'}${of}` };
  }
  if (status?.authorizationUrl) return { label: 'Needs sign-in', tone: 'warn' };
  if (status) return { label: 'Unreachable', tone: 'bad' };

  return undefined;
}
