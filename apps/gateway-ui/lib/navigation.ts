import {
  AlarmClock,
  BookOpen,
  Cpu,
  Fingerprint,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  Plug,
  Settings2,
  Smartphone,
  Sparkles,
  Sticker,
} from 'lucide-react';

export type NavigationItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  group: 'gateway' | 'workspace' | 'capabilities';
  /** The route every page of the section starts with, when it differs from where the link goes. */
  prefix?: string;
};

/**
 * The sections of the panel, in the order the sidebar shows them. A section is a route. The
 * gateway group comes first and holds what belongs to the whole installation, whichever agent
 * is open; everything after it is the open agent's own.
 */
export const navigation: NavigationItem[] = [
  { href: '/providers', label: 'Providers', icon: Plug, group: 'gateway' },
  {
    href: '/settings/appearance',
    prefix: '/settings',
    label: 'Settings',
    icon: Settings2,
    group: 'gateway',
  },
  { href: '/', label: 'Overview', icon: LayoutDashboard, group: 'workspace' },
  { href: '/identity', label: 'Identity', icon: Fingerprint, group: 'workspace' },
  { href: '/sessions', label: 'Sessions', icon: MessageSquare, group: 'workspace' },
  { href: '/models', label: 'Model defaults', icon: Cpu, group: 'workspace' },
  { href: '/channels', label: 'Channels', icon: Smartphone, group: 'workspace' },
  { href: '/schedules', label: 'Schedules', icon: AlarmClock, group: 'workspace' },
  { href: '/memories', label: 'Memories', icon: BookOpen, group: 'capabilities' },
  { href: '/skills', label: 'Skills', icon: Sparkles, group: 'capabilities' },
  { href: '/stickers', label: 'Stickers', icon: Sticker, group: 'capabilities' },
  { href: '/mcp', label: 'MCP servers', icon: Plug, group: 'capabilities' },
];

export const groupLabels = {
  gateway: 'Gateway',
  workspace: 'Workspace',
  capabilities: 'Capabilities',
} as const;

/** The deepest section whose route prefixes the current one, so a child route stays marked. */
export function currentSection(pathname: string): NavigationItem | undefined {
  const path = pathname.replace(/\/$/, '') || '/';

  const root = (item: NavigationItem) => item.prefix ?? item.href;

  return [...navigation]
    .sort((a, b) => root(b).length - root(a).length)
    .find((item) => path === root(item) || path.startsWith(`${root(item)}/`));
}
