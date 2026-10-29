import {
  AlarmClock,
  BookOpen,
  Cable,
  Cpu,
  Fingerprint,
  FolderGit2,
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
  /** Relative to the open agent: `''` is its overview, `'sessions'` is `/agents/:id/sessions`. */
  path: string;
  label: string;
  icon: LucideIcon;
  group: NavigationGroup;
};

export const navigationGroups = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'agent-setup', label: 'Agent setup' },
  { id: 'connections', label: 'Connections' },
  { id: 'automation', label: 'Automation' },
] as const;

type NavigationGroup = (typeof navigationGroups)[number]['id'];

/** Routes are ordered within their section in the order shown by the sidebar. */
export const navigation: NavigationItem[] = [
  { path: '', label: 'Overview', icon: LayoutDashboard, group: 'workspace' },
  { path: 'sessions', label: 'Chats', icon: MessageSquare, group: 'workspace' },
  { path: 'projects', label: 'Projects', icon: FolderGit2, group: 'workspace' },
  { path: 'identity', label: 'Identity', icon: Fingerprint, group: 'agent-setup' },
  { path: 'models', label: 'Model defaults', icon: Cpu, group: 'agent-setup' },
  { path: 'memories', label: 'Memories', icon: BookOpen, group: 'agent-setup' },
  { path: 'skills', label: 'Skills', icon: Sparkles, group: 'agent-setup' },
  { path: 'providers', label: 'Providers', icon: Plug, group: 'connections' },
  { path: 'integrations', label: 'Integrations', icon: Cable, group: 'connections' },
  { path: 'channels', label: 'Channels', icon: Smartphone, group: 'connections' },
  { path: 'ssh-keys', label: 'SSH keys', icon: KeyRound, group: 'connections' },
  { path: 'remote', label: 'Remote Control', icon: Monitor, group: 'connections' },
  { path: 'schedules', label: 'Schedules', icon: AlarmClock, group: 'automation' },
];

/** Where a page of one agent lives. Every screen of the panel belongs to an agent. */
export function agentPath(profileId: string, path = ''): string {
  const rest = path.replace(/^\//, '');

  return `/agents/${encodeURIComponent(profileId)}${rest ? `/${rest}` : ''}`;
}

/** The part of an agent's route after its id: `/agents/a/sessions/b` reads `sessions/b`. */
function withinAgent(pathname: string): string | undefined {
  const match = /^\/agents\/[^/]+(?:\/(.*))?$/.exec(pathname.replace(/\/$/, ''));

  return match ? (match[1] ?? '') : undefined;
}

/** The deepest section whose route prefixes the current one, so a child route stays marked. */
export function currentSection(pathname: string): NavigationItem | undefined {
  const path = withinAgent(pathname);

  if (path === undefined) return undefined;

  return [...navigation]
    .sort((a, b) => b.path.length - a.path.length)
    .find((item) => path === item.path || (item.path && path.startsWith(`${item.path}/`)));
}
