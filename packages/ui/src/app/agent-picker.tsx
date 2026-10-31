'use client';

import { Bot, Plus, Settings2 } from 'lucide-react';
import { Suspense, useRef, useState } from 'react';
import { AgentFace, HoverTip, Picker, PickerAction, PickerRow } from '../kit';
import { agentPath } from '../lib/navigation';
import { useContacts } from '../lib/query/agent';
import { useProfiles } from '../lib/query/profile';
import { useAgentOverlay } from '../lib/stores/agent-overlay';
import { useProfileId } from '../lib/workspace';
import { useRouter } from '../platform/navigation';
import { WaitingCount } from './agent-overlays';

const gear =
  'relative mr-1 grid size-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-glass-hover hover:text-ink';

/**
 * The way into the agent's settings, always in reach. Contacts waiting for approval are counted
 * on it, and it opens where they wait.
 */
function SettingsButton() {
  const open = useAgentOverlay((state) => state.openSettings);
  const pending = useContacts().filter((contact) => contact.status === 'pending').length;
  return (
    <HoverTip tip="Agent settings">
      <button
        type="button"
        aria-label="Agent settings"
        className={gear}
        onClick={() => open(pending > 0 ? 'channels' : 'identity')}
      >
        <Settings2 size={15} />
        {pending > 0 && (
          <span className="absolute -top-1 -right-1">
            <WaitingCount count={pending} />
          </span>
        )}
      </button>
    </HoverTip>
  );
}

/**
 * The agent in use, at the foot of the sidebar: its face and name open the others, each with
 * its own gear to its settings, and its own gear stays beside it. Switching opens the other's chats.
 */
export function AgentPicker({ createAgent }: { createAgent: () => void }) {
  const profiles = useProfiles().data ?? [];
  const profileId = useProfileId();
  const router = useRouter();
  const openSettings = useAgentOverlay((state) => state.openSettings);
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
                onSettings={close(() => {
                  // Another agent's settings are opened from that agent, which is what they edit.
                  if (profile.id !== profileId) router.push(agentPath(profile.id, 'sessions'));
                  openSettings();
                })}
              />
            ))}
          </Picker>
        </div>
        {current && (
          <Suspense fallback={null}>
            <SettingsButton />
          </Suspense>
        )}
      </div>
    </div>
  );
}
