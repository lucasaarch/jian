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

/** Where an agent's new chat opens: its chats, asked to start one, in a project when given. */
export function newChatPath(profileId: string, projectId?: string): string {
  const project = projectId ? `&project=${encodeURIComponent(projectId)}` : '';

  return agentPath(profileId, `sessions?new${project}`);
}
