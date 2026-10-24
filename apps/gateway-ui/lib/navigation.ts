import type { ProfessionId } from '@jian/contracts';
import {
  AlarmClock,
  BookOpen,
  Cpu,
  Fingerprint,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Megaphone,
  MessageSquare,
  Monitor,
  Plug,
  Smartphone,
  Sparkles,
  UsersRound,
} from 'lucide-react';

export type NavigationItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  group: 'global' | 'profession' | 'agent';
  profession?: ProfessionId;
};

/**
 * Global is installation-wide; profession routes only apply to that profession; Agent holds
 * sections shared by every agent.
 */
export const navigation: NavigationItem[] = [
  { href: '/providers', label: 'Providers', icon: Plug, group: 'global' },
  { href: '/remote', label: 'Remote Control', icon: Monitor, group: 'global' },
  { href: '/teams', label: 'Teams', icon: UsersRound, group: 'global' },
  { href: '/', label: 'Overview', icon: LayoutDashboard, group: 'agent' },
  { href: '/identity', label: 'Identity', icon: Fingerprint, group: 'agent' },
  {
    href: '/ssh-keys',
    label: 'SSH keys',
    icon: KeyRound,
    group: 'profession',
    profession: 'developer',
  },
  { href: '/sessions', label: 'Chats', icon: MessageSquare, group: 'agent' },
  { href: '/models', label: 'Model defaults', icon: Cpu, group: 'agent' },
  { href: '/channels', label: 'Channels', icon: Smartphone, group: 'agent' },
  { href: '/schedules', label: 'Schedules', icon: AlarmClock, group: 'agent' },
  { href: '/memories', label: 'Memories', icon: BookOpen, group: 'agent' },
  { href: '/skills', label: 'Skills', icon: Sparkles, group: 'agent' },
  {
    href: '/campaigns',
    label: 'Campaigns',
    icon: Megaphone,
    group: 'profession',
    profession: 'attendant',
  },
  { href: '/mcp', label: 'MCP servers', icon: Plug, group: 'agent' },
];

const professionLabels: Record<ProfessionId, string> = {
  developer: 'Developer',
  attendant: 'Sales Attendant',
};

export function navigationGroups(professionId: ProfessionId | null | undefined) {
  return [
    { id: 'global', label: 'Global' },
    ...(professionId ? [{ id: 'profession', label: professionLabels[professionId] }] : []),
    ...(professionId ? [{ id: 'agent', label: 'Agent' }] : []),
  ] as const;
}

/** The deepest section whose route prefixes the current one, so a child route stays marked. */
export function currentSection(pathname: string): NavigationItem | undefined {
  const path = pathname.replace(/\/$/, '') || '/';

  return [...navigation]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => path === item.href || path.startsWith(`${item.href}/`));
}
