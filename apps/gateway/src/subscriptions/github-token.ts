import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceOf } from '../agent/workspace.js';
import type { GithubTokenSource } from './github-poll.js';

/**
 * Reads the profile workspace’s `gh` login token when present. Polling uses it for private
 * repos; public repos work without it. The gateway never inherits the host process `GH_TOKEN`.
 */
export function profileGithubTokenSource(): GithubTokenSource {
  return {
    async tokenFor(profileId: string) {
      try {
        const home = await workspaceOf(profileId);
        const text = await readFile(join(home, '.config', 'gh', 'hosts.yml'), 'utf8');
        const match = /^\s*oauth_token:\s*(\S+)\s*$/m.exec(text);
        return match?.[1];
      } catch {
        return undefined;
      }
    },
  };
}
