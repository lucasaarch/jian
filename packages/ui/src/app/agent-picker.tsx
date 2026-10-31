'use client';

import { Bot, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { AgentFace, Picker, PickerAction, PickerRow } from '../kit';
import { agentPath, agentSettingsPath } from '../lib/navigation';
import { useProfiles } from '../lib/query/profile';
import { useProfileId } from '../lib/workspace';
import { useRouter } from '../platform/navigation';

/**
 * The agent in use, at the foot of the sidebar: its face and name open the others, each with
 * its own gear to its settings. Switching opens the other's chats.
 */
export function AgentPicker({ createAgent }: { createAgent: () => void }) {
  const profiles = useProfiles().data ?? [];
  const profileId = useProfileId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The whole row: the list opens over it, as wide as it.
  const row = useRef<HTMLDivElement>(null);
  const current = profiles.find((profile) => profile.id === profileId);
  const close = (then: () => void) => () => {
    setOpen(false);
    then();
  };

  return (
    <div className="p-2">
      <div
        ref={row}
        className="flex items-center rounded-lg transition-colors hover:bg-glass-hover has-data-popup-open:bg-glass-press"
      >
        <div className="min-w-0 flex-1">
          <Picker
            label="Agent"
            shape="row"
            anchor={row}
            open={open}
            onOpenChange={setOpen}
            trigger={
              <>
                {current ? (
                  <AgentFace name={current.name} avatar={current.avatar} size={1.75} />
                ) : (
                  <span className="grid size-7 place-items-center text-muted">
                    <Bot size={16} />
                  </span>
                )}
                <span className="truncate">{current?.name ?? 'No agent'}</span>
              </>
            }
            footer={
              <PickerAction icon={<Plus size={15} />} onClick={close(createAgent)}>
                Create an agent
              </PickerAction>
            }
          >
            {profiles.map((profile) => (
              <PickerRow
                key={profile.id}
                leading={<AgentFace name={profile.name} avatar={profile.avatar} />}
                label={profile.name}
                selected={profile.id === profileId}
                onPick={close(() => router.push(agentPath(profile.id, 'sessions')))}
                onSettings={close(() => router.push(agentSettingsPath(profile.id)))}
              />
            ))}
          </Picker>
        </div>
      </div>
    </div>
  );
}
