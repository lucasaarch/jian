import type { ReactNode } from 'react';
import type { Skill } from '../../lib/api';
import { ProviderLogo } from '../ui';

/** Where a skill came from: a vendor's own catalog by its logo, any other repository by path. */
function originOf(url?: string): { label: string; path?: string; logo?: ReactNode } {
  if (!url) return { label: 'Written here' };
  const path = new URL(url).pathname.split('/').slice(1, 3).join('/');

  if (path.startsWith('anthropics/'))
    return { label: 'Anthropic', path, logo: <ProviderLogo kind="anthropic" size={22} /> };
  if (path.startsWith('openai/'))
    return { label: 'OpenAI', path, logo: <ProviderLogo kind="openai" size={22} /> };

  return { label: 'Imported', path };
}

/** Who a skill is owed to: the agent that wrote it for itself, or where the owner got it. */
export function sourceOf(skill: Skill, agentName: string): ReturnType<typeof originOf> {
  return skill.writtenBy === 'agent'
    ? { label: `Written by ${agentName}` }
    : originOf(skill.origin?.url);
}
