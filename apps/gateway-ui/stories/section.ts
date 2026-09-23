import { fn } from 'storybook/test';
import type { SectionProps } from '../components/props';
import { gatewayApi, type ProfileData } from '../lib/api';
import * as fixtures from './fixtures';

/** The open profile's whole screenful, as the workspace would have loaded it. */
export const profileData: ProfileData = {
  providers: fixtures.providers,
  providerModels: fixtures.providerModels,
  modelDefaults: fixtures.modelDefaults,
  sessions: fixtures.sessions,
  channels: fixtures.channels,
  memories: fixtures.memories,
  activities: fixtures.runs,
  deliveries: fixtures.deliveries,
  contacts: fixtures.contacts,
  groups: fixtures.groups,
};

/**
 * What the layout hands a section. The client is the real one, answered by the story's
 * handlers; an action reports success and changes nothing.
 */
export function sectionProps(overrides: Partial<SectionProps> = {}): SectionProps {
  const [profile] = fixtures.profiles;

  if (!profile) throw new Error('The fixtures hold no profile');

  return {
    profile,
    data: profileData,
    api: gatewayApi(),
    mutate: fn(async (action: () => Promise<unknown>) => {
      await action();

      return true;
    }),
    busy: false,
    ...overrides,
  };
}
