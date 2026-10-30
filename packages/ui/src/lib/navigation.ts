import {
  AlarmClock,
  BookOpen,
  Cable,
  Cpu,
  Fingerprint,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  Monitor,
  Plug,
  Smartphone,
  Sparkles,
} from 'lucide-react';

export type NavigationItem = {
  /**
   * Relative to where the item lives: for an agent's item, to the open agent — `''` is its
   * overview, `'sessions'` is `/agents/:id/sessions`; for the gateway's, to `/settings`.
   */
  path: string;
  label: string;
  icon: LucideIcon;
  group: NavigationGroup;
  /**
   * Only on a server: a desktop app's own gateway has no channels, and machines elsewhere cannot
   * reach it to be controlled.
   */
  serverOnly?: true;
};

export const navigationGroups = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'agent-setup', label: 'Agent setup' },
  { id: 'connections', label: 'Connections' },
  { id: 'automation', label: 'Automation' },
  // Shared by every agent: these screens live under `/settings`, outside any agent.
  { id: 'gateway', label: 'Gateway' },
] as const;

type NavigationGroup = (typeof navigationGroups)[number]['id'];

/** Routes are ordered within their section in the order shown by the sidebar. */
export const navigation: NavigationItem[] = [
  { path: '', label: 'Overview', icon: LayoutDashboard, group: 'workspace' },
  { path: 'sessions', label: 'Chats', icon: MessageSquare, group: 'workspace' },
  { path: 'identity', label: 'Identity', icon: Fingerprint, group: 'agent-setup' },
  { path: 'memories', label: 'Memories', icon: BookOpen, group: 'agent-setup' },
  { path: 'skills', label: 'Skills', icon: Sparkles, group: 'agent-setup' },
  { path: 'channels', label: 'Channels', icon: Smartphone, group: 'connections', serverOnly: true },
  { path: 'schedules', label: 'Schedules', icon: AlarmClock, group: 'automation' },
  { path: 'providers', label: 'Providers', icon: Plug, group: 'gateway' },
  { path: 'models', label: 'Model defaults', icon: Cpu, group: 'gateway' },
  { path: 'integrations', label: 'Integrations', icon: Cable, group: 'gateway' },
  { path: 'ssh-keys', label: 'SSH keys', icon: KeyRound, group: 'gateway' },
  { path: 'remote', label: 'Remote Control', icon: Monitor, group: 'gateway', serverOnly: true },
];

/** Whether an item is one of the gateway's own screens rather than an agent's. */
export const isGatewayItem = (item: NavigationItem) => item.group === 'gateway';

/** Where a gateway screen lives: the same for every agent. */
export function settingsPath(path = ''): string {
  const rest = path.replace(/^\//, '');

  return `/settings${rest ? `/${rest}` : ''}`;
}

/** Where a page of one agent lives. */
export function agentPath(profileId: string, path = ''): string {
  const rest = path.replace(/^\//, '');

  return `/agents/${encodeURIComponent(profileId)}${rest ? `/${rest}` : ''}`;
}

/** The part of an agent's route after its id: `/agents/a/sessions/b` reads `sessions/b`. */
function withinAgent(pathname: string): string | undefined {
  const match = /^\/agents\/[^/]+(?:\/(.*))?$/.exec(pathname.replace(/\/$/, ''));

  return match ? (match[1] ?? '') : undefined;
}

/** The part of a gateway route after `/settings`. */
function withinSettings(pathname: string): string | undefined {
  const match = /^\/settings(?:\/(.*))?$/.exec(pathname.replace(/\/$/, ''));

  return match ? (match[1] ?? '') : undefined;
}

/** The deepest section whose route prefixes the current one, so a child route stays marked. */
export function currentSection(pathname: string): NavigationItem | undefined {
  const agent = withinAgent(pathname);
  const settings = withinSettings(pathname);
  const path = agent ?? settings;

  if (path === undefined) return undefined;

  return [...navigation]
    .filter((item) => isGatewayItem(item) === (settings !== undefined))
    .sort((a, b) => b.path.length - a.path.length)
    .find((item) => path === item.path || (item.path && path.startsWith(`${item.path}/`)));
}
