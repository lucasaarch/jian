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

/** One skill's own page, under Plugins: built-in or of the library, by its name. */
export const skillPath = (profileId: string, name: string) =>
  agentPath(profileId, `plugins/skills/${encodeURIComponent(name)}`);

/**
 * One connector's own page, under Plugins, by its id: `github`, an app of the catalog, or
 * `custom:` and the name of a server the owner added. `from` is the tab it was opened from,
 * which its way back returns to.
 */
export const connectorPath = (profileId: string, id: string, from?: 'connectors') =>
  agentPath(
    profileId,
    `plugins/connectors/${encodeURIComponent(id)}${from ? `?from=${from}` : ''}`,
  );

const SKILL = /^\/agents\/[^/]+\/plugins\/skills\/([^/]+)\/?$/;
const CONNECTOR = /^\/agents\/[^/]+\/plugins\/connectors\/([^/]+)\/?$/;

/** What an address of that shape names, as it was written before it was escaped. */
function namedAt(shape: RegExp, pathname: string): string | undefined {
  const name = shape.exec(pathname)?.[1];

  try {
    return name && decodeURIComponent(name);
  } catch {
    // An address cut mid-escape names nothing; the page says there is no such plugin.
    return name;
  }
}

/** The skill whose page a pathname is, by its name; undefined anywhere else. */
export const skillAt = (pathname: string) => namedAt(SKILL, pathname);

/** The connector whose page a pathname is, by its id; undefined anywhere else. */
export const connectorAt = (pathname: string) => namedAt(CONNECTOR, pathname);

/** Whether a pathname is an agent's Plugins, or the page of one skill or connector under them. */
export const onPlugins = (pathname: string) =>
  /^\/agents\/[^/]+\/plugins\/?$/.test(pathname) ||
  SKILL.test(pathname) ||
  CONNECTOR.test(pathname);

/** Where an agent's new chat opens: its chats, asked to start one, in a project when given. */
export function newChatPath(profileId: string, projectId?: string): string {
  const project = projectId ? `&project=${encodeURIComponent(projectId)}` : '';

  return agentPath(profileId, `sessions?new${project}`);
}
