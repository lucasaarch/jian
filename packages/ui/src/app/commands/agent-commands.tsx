'use client';

import {
  AlarmClock,
  Brain,
  LayoutDashboard,
  MessagesSquare,
  Search,
  Sparkles,
  SquarePen,
  UserCog,
  UserPlus,
} from 'lucide-react';
import { useMemo } from 'react';
import { AgentFace } from '../../kit/face';
import type { Profile } from '../../lib/api';
import { agentPath, agentSettingsPath, newChatPath } from '../../lib/navigation';
import { useRouter } from '../../platform/navigation';
import { customizePath, schedulesPath } from '../agent-pages';
import { searchChats } from '../sidebar-bar';
import { type AppCommand, useCommands } from './registry';

/**
 * What can be done with the agents of the gateway open: the open agent's places, a new chat
 * with it, another agent to switch to, one to create. `current` is undefined while no agent is
 * open — the Welcome, an empty gateway — and only creating one is offered then.
 */
export function useAgentCommands({
  profiles,
  current,
  createAgent,
}: {
  profiles: Profile[] | undefined;
  current: Profile | undefined;
  createAgent: () => void;
}): void {
  const router = useRouter();
  const commands = useMemo<AppCommand[]>(() => {
    if (!profiles) return [];
    const create: AppCommand = {
      id: 'create-agent',
      title: 'Create an agent',
      keywords: ['new', 'agent', 'add', 'profile'],
      icon: <UserPlus size={15} />,
      run: createAgent,
    };
    if (!current) return [create];
    const id = current.id;
    const place = (path: string) => () => router.push(path);
    return [
      {
        id: 'new-chat',
        title: 'New chat',
        keywords: ['conversation', 'start', 'compose'],
        icon: <SquarePen size={15} />,
        keys: { key: 'n' },
        run: place(newChatPath(id)),
      },
      {
        id: 'search-chats',
        title: 'Search chats',
        keywords: ['find', 'conversation', 'go to'],
        icon: <Search size={15} />,
        keys: { key: 'k' },
        run: searchChats,
      },
      {
        id: 'overview',
        keys: { key: 'o', shift: true, alt: true },
        title: 'Overview',
        detail: current.name,
        keywords: ['usage', 'activity', 'dashboard', 'costs', 'tokens'],
        icon: <LayoutDashboard size={15} />,
        run: place(agentPath(id)),
      },
      {
        id: 'schedules',
        keys: { key: 's', shift: true, alt: true },
        title: 'Schedules',
        detail: current.name,
        keywords: ['schedule', 'reminder', 'recurring', 'cron', 'later'],
        icon: <AlarmClock size={15} />,
        run: place(schedulesPath(id)),
      },
      {
        id: 'skills',
        keys: { key: 'k', shift: true, alt: true },
        title: 'Skills',
        detail: current.name,
        keywords: ['customize', 'skill', 'abilities'],
        icon: <Sparkles size={15} />,
        run: place(customizePath(id, 'skills')),
      },
      {
        id: 'memories',
        keys: { key: 'm', shift: true, alt: true },
        title: 'Memories',
        detail: current.name,
        keywords: ['customize', 'memory', 'remember', 'facts'],
        icon: <Brain size={15} />,
        run: place(customizePath(id, 'memories')),
      },
      {
        id: 'channels',
        keys: { key: 'c', shift: true, alt: true },
        title: 'Channels',
        detail: current.name,
        keywords: ['customize', 'whatsapp', 'telegram', 'api', 'connect'],
        icon: <MessagesSquare size={15} />,
        run: place(customizePath(id, 'channels')),
      },
      {
        id: 'agent-settings',
        keys: { key: 'a', shift: true, alt: true },
        title: 'Agent settings',
        detail: current.name,
        keywords: ['identity', 'name', 'instructions', 'reset', 'delete', 'agent'],
        icon: <UserCog size={15} />,
        run: place(agentSettingsPath(id)),
      },
      ...profiles
        .filter((profile) => profile.id !== id)
        .map<AppCommand>((profile) => ({
          id: `switch-agent-${profile.id}`,
          title: `Switch to ${profile.name}`,
          keywords: ['agent', 'change', 'open'],
          icon: <AgentFace name={profile.name} avatar={profile.avatar} size={1} />,
          run: place(agentPath(profile.id, 'sessions')),
        })),
      create,
    ];
  }, [profiles, current, createAgent, router]);
  useCommands('agent', commands);
}
