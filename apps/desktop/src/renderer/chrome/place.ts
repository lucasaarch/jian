/** The panel's sections as the title bar names them, by the path after an agent or settings. */
const AGENT: Record<string, string> = {
  '': 'Overview',
  sessions: 'Chats',
  channels: 'Channels',
  identity: 'Identity',
  memories: 'Memories',
  schedules: 'Schedules',
  skills: 'Skills',
};

const SETTINGS: Record<string, string> = {
  providers: 'Providers',
  models: 'Models',
  remote: 'Remote control',
  'ssh-keys': 'SSH keys',
  integrations: 'Integrations',
  'integrations/github': 'GitHub',
  'integrations/mcps': 'MCP servers',
};

/** Where the panel is, in a word or two: what the title bar shows beside the gateway's name. */
export function placeName(href: string): string {
  const pathname = href.split('?')[0] ?? '/';
  const agent = /^\/agents\/[^/]+\/?([^/]*)/.exec(pathname);
  if (agent) return AGENT[agent[1] ?? ''] ?? 'Overview';
  const settings = /^\/settings\/?(.*)$/.exec(pathname);
  if (settings) return `Settings · ${SETTINGS[settings[1] ?? ''] ?? 'Providers'}`;
  return 'Home';
}
