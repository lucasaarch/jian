import { createHash } from 'node:crypto';

/**
 * How the name the model calls a server's `tool` by ends, whatever the server is called: what
 * a recorded call is recognised by, long after the run that made it. The hash keeps two long
 * names apart once they are cut to 18 characters.
 */
export function exposedEnding(tool: string): string {
  const suffix = createHash('sha256').update(tool).digest('hex').slice(0, 8);

  return `_${tool.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 18)}_${suffix}`;
}
