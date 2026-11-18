/** Where a place of one agent lives: `'sessions'` is its chats. */
export function agentPath(profileId: string, path = ''): string {
  const rest = path.replace(/^\//, '');

  return `/agents/${encodeURIComponent(profileId)}${rest ? `/${rest}` : ''}`;
}

/** An address that opens an agent's settings, over its chats. */
export const agentSettingsPath = (profileId: string) => agentPath(profileId, 'settings');

/** The pull requests of the connected GitHub accounts, in place of an agent's chat. */
export const pullsPath = (profileId: string) => agentPath(profileId, 'pulls');

/** Whether a pathname is an agent's pull requests. */
export const onPulls = (pathname: string) => /^\/agents\/[^/]+\/pulls\/?$/.test(pathname);

/** The agent's activity, in place of its chat. */
export const activityPath = (profileId: string) => agentPath(profileId, 'activity');

/** Whether a pathname is an agent's activity. */
export const onActivity = (pathname: string) => /^\/agents\/[^/]+\/activity\/?$/.test(pathname);

/** Every Artifact the agent made, in place of its chat. */
export const artifactsPath = (profileId: string) => agentPath(profileId, 'artifacts');

/** Whether a pathname is an agent's Artifacts. */
export const onArtifacts = (pathname: string) => /^\/agents\/[^/]+\/artifacts\/?$/.test(pathname);

/**
 * What the agent can use, in place of its chat: the connectors and the skills every agent
 * shares. Given a tab, the address opens Plugins on it.
 */
export const pluginsPath = (profileId: string, tab?: 'connectors' | 'skills') =>
  agentPath(profileId, tab ? `plugins?tab=${tab}` : 'plugins');

/** Whether a pathname is an agent's Plugins. */
export const onPlugins = (pathname: string) => /^\/agents\/[^/]+\/plugins\/?$/.test(pathname);

/** Where an agent's new chat opens: its chats, asked to start one, in a project when given. */
export function newChatPath(profileId: string, projectId?: string): string {
  const project = projectId ? `&project=${encodeURIComponent(projectId)}` : '';

  return agentPath(profileId, `sessions?new${project}`);
}
