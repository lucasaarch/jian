'use client';

import {
  Activity,
  AlarmClock,
  Brain,
  Compass,
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
import { agentPath, newChatPath } from '../../lib/navigation';
import { useAgentOverlay } from '../../lib/stores/agent-overlay';
import { useOnboarding } from '../../lib/stores/onboarding';
import { useRouter } from '../../platform/navigation';
import { searchChats } from '../sidebar-bar';
import { type AppCommand, useCommands } from './registry';

/**
 * What can be done with the agents of the gateway open: the open agent's places, a new chat
 * with it, another agent to switch to, one to create. `current` is undefined while no agent is
 * open — an empty gateway — and only creating one or meeting Jian again is offered then; none of
 * this is offered while the Welcome is already up.
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
    const onboarding: AppCommand = {
      id: 'show-onboarding',
      title: 'Show onboarding',
      keywords: ['welcome', 'introduction', 'setup', 'start', 'tour'],
      icon: <Compass size={15} />,
      run: () => useOnboarding.getState().show(),
    };
    if (!current) return [create, onboarding];
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
        title: 'Activity',
        detail: current.name,
        keywords: ['overview', 'usage', 'stats', 'dashboard', 'costs', 'tokens'],
        icon: <Activity size={15} />,
        run: () => useAgentOverlay.getState().openSettings('activity'),
      },
      {
        id: 'schedules',
        keys: { key: 's', shift: true, alt: true },
        title: 'Schedules',
        detail: current.name,
        keywords: ['schedule', 'reminder', 'recurring', 'cron', 'later'],
        icon: <AlarmClock size={15} />,
        run: () => useAgentOverlay.getState().openSchedules(),
      },
      {
        id: 'skills',
        keys: { key: 'k', shift: true, alt: true },
        title: 'Skills',
        detail: current.name,
        keywords: ['agent', 'skill', 'abilities'],
        icon: <Sparkles size={15} />,
        run: () => useAgentOverlay.getState().openSettings('skills'),
      },
      {
        id: 'memories',
        keys: { key: 'm', shift: true, alt: true },
        title: 'Memories',
        detail: current.name,
        keywords: ['agent', 'memory', 'remember', 'facts'],
        icon: <Brain size={15} />,
        run: () => useAgentOverlay.getState().openSettings('memories'),
      },
      {
        id: 'channels',
        keys: { key: 'c', shift: true, alt: true },
        title: 'Channels',
        detail: current.name,
        keywords: ['agent', 'whatsapp', 'telegram', 'api', 'connect'],
        icon: <MessagesSquare size={15} />,
        run: () => useAgentOverlay.getState().openSettings('channels'),
      },
      {
        id: 'agent-settings',
        keys: { key: 'a', shift: true, alt: true },
        title: 'Agent settings',
        detail: current.name,
        keywords: ['identity', 'name', 'instructions', 'reset', 'delete', 'agent'],
        icon: <UserCog size={15} />,
        run: () => useAgentOverlay.getState().openSettings(),
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
      onboarding,
    ];
  }, [profiles, current, createAgent, router]);
  useCommands('agent', commands);
}
