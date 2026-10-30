/** Where a place of one agent lives: `''` is its Overview, `'sessions'` its chats. */
export function agentPath(profileId: string, path = ''): string {
  const rest = path.replace(/^\//, '');

  return `/agents/${encodeURIComponent(profileId)}${rest ? `/${rest}` : ''}`;
}

/** Where an agent's settings open, in the conversation's place. */
export const agentSettingsPath = (profileId: string) => agentPath(profileId, 'settings');

/** Where an agent's new chat opens: its chats, asked to start one, in a project when given. */
export function newChatPath(profileId: string, projectId?: string): string {
  const project = projectId ? `&project=${encodeURIComponent(projectId)}` : '';

  return agentPath(profileId, `sessions?new${project}`);
}
