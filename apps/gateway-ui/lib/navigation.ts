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
  href: string;
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
  { href: '/sessions', label: 'Chats', icon: MessageSquare, group: 'workspace' },
  { href: '/', label: 'Overview', icon: LayoutDashboard, group: 'workspace' },
  { href: '/projects', label: 'Projects', icon: FolderGit2, group: 'workspace' },
  { href: '/identity', label: 'Identity', icon: Fingerprint, group: 'agent-setup' },
  { href: '/models', label: 'Model defaults', icon: Cpu, group: 'agent-setup' },
  { href: '/memories', label: 'Memories', icon: BookOpen, group: 'agent-setup' },
  { href: '/skills', label: 'Skills', icon: Sparkles, group: 'agent-setup' },
  { href: '/providers', label: 'Providers', icon: Plug, group: 'connections' },
  { href: '/integrations', label: 'Integrations', icon: Cable, group: 'connections' },
  { href: '/channels', label: 'Channels', icon: Smartphone, group: 'connections' },
  { href: '/ssh-keys', label: 'SSH keys', icon: KeyRound, group: 'connections' },
  { href: '/remote', label: 'Remote Control', icon: Monitor, group: 'connections' },
  { href: '/schedules', label: 'Schedules', icon: AlarmClock, group: 'automation' },
];

/** The deepest section whose route prefixes the current one, so a child route stays marked. */
export function currentSection(pathname: string): NavigationItem | undefined {
  const path = pathname.replace(/\/$/, '') || '/';

  return [...navigation]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => path === item.href || path.startsWith(`${item.href}/`));
}
