import {
  AlarmClock,
  BookOpen,
  Cpu,
  Fingerprint,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  Plug,
  Smartphone,
  Sparkles,
} from 'lucide-react';

export type NavigationItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  group: 'workspace' | 'capabilities';
};

/** The sections of the panel, in the order the sidebar shows them. A section is a route. */
export const navigation: NavigationItem[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard, group: 'workspace' },
  { href: '/identity', label: 'Identity', icon: Fingerprint, group: 'workspace' },
  { href: '/providers', label: 'Providers', icon: Plug, group: 'workspace' },
  { href: '/models', label: 'Model defaults', icon: Cpu, group: 'workspace' },
  { href: '/channels', label: 'Channels', icon: Smartphone, group: 'workspace' },
  { href: '/sessions', label: 'Sessions', icon: MessageSquare, group: 'workspace' },
  { href: '/schedules', label: 'Schedules', icon: AlarmClock, group: 'workspace' },
  { href: '/memories', label: 'Memories', icon: BookOpen, group: 'capabilities' },
  { href: '/skills', label: 'Skills', icon: Sparkles, group: 'capabilities' },
  { href: '/mcp', label: 'MCP servers', icon: Plug, group: 'capabilities' },
];

export const groupLabels = { workspace: 'Workspace', capabilities: 'Capabilities' } as const;

/** The deepest section whose route prefixes the current one, so a child route stays marked. */
export function currentSection(pathname: string): NavigationItem | undefined {
  const path = pathname.replace(/\/$/, '') || '/';

  return [...navigation]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => path === item.href || path.startsWith(`${item.href}/`));
}
