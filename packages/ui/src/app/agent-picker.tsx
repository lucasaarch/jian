'use client';

import { Bot, Plus } from 'lucide-react';
import { useState } from 'react';
import { AgentFace, Picker, PickerAction, PickerRow } from '../kit';
import { agentPath } from '../lib/navigation';
import { useProfiles } from '../lib/query/profile';
import { useProfileId } from '../lib/workspace';
import { useRouter } from '../platform/navigation';

/** The agent in use, in the status bar: switching opens its chats; its gear opens its settings. */
export function AgentPicker({
  openSettings,
  createAgent,
}: {
  openSettings: (profileId: string) => void;
  createAgent: () => void;
}) {
  const profiles = useProfiles().data ?? [];
  const profileId = useProfileId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const current = profiles.find((profile) => profile.id === profileId);
  const close = (then: () => void) => () => {
    setOpen(false);
    then();
  };

  return (
    <Picker
      label="Agent"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          {current ? (
            <AgentFace name={current.name} avatar={current.avatar} size={1} />
          ) : (
            <Bot size={13} />
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
          {...(profile.summary ? { detail: profile.summary } : {})}
          selected={profile.id === profileId}
          onPick={close(() => router.push(agentPath(profile.id, 'sessions')))}
          onSettings={close(() => openSettings(profile.id))}
        />
      ))}
    </Picker>
  );
}
