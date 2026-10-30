'use client';

import { Plus } from 'lucide-react';
import { agentPath, currentSection, isGatewayItem } from '../../lib/navigation';
import { useProfiles } from '../../lib/query/profile';
import { useLastProfile } from '../../lib/stores/last-profile';
import { useBusy, useWorkingAgentId } from '../../lib/workspace';
import { usePathname, useRouter } from '../../platform/navigation';
import { Avatar } from '../profile/avatar-field';
import { Select } from '../ui/select';

export function ProfileSwitcher({ onCreate }: { onCreate: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const profiles = useProfiles().data ?? [];
  const selected = useWorkingAgentId() ?? '';
  const remember = useLastProfile((state) => state.remember);
  const profile = profiles.find((item) => item.id === selected);
  const busy = useBusy();
  // Another agent opens on the same section; anything deeper, such as one conversation,
  // belonged to the agent being left. A gateway screen is everyone's, so it stays open.
  const select = (profileId: string) => {
    const section = currentSection(pathname);

    if (section && isGatewayItem(section)) return remember(profileId);

    router.push(agentPath(profileId, section?.path));
  };
  return (
    <div className="profile-selector">
      <Select
        aria-label="Active agent"
        variant="subtle"
        value={selected}
        onValueChange={select}
        disabled={busy}
        searchThreshold={5}
        options={profiles.map((item) => ({
          value: item.id,
          label: item.name,
          icon: <Avatar name={item.name} avatar={item.avatar} className="mini-avatar" />,
        }))}
        renderValue={() => (
          <>
            <Avatar name={profile?.name} avatar={profile?.avatar} className="mini-avatar" />
            <span className="profile-trigger-copy">
              <small>Active agent</small>
              <strong>{profile?.name ?? 'Select an agent'}</strong>
            </span>
          </>
        )}
        footer={(close) => (
          <button
            type="button"
            onClick={() => {
              close();
              onCreate();
            }}
          >
            <Plus size={16} />
            New agent
          </button>
        )}
      />
    </div>
  );
}
