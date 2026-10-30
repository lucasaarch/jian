'use client';

import { useState } from 'react';
import { admitsAll } from '../../components/channels/connect';
import type { SectionActions } from '../../components/props';
import { Action, SettingsRow, Toggle } from '../../kit';
import type { Channel } from '../../lib/api';
import { useAgent } from '../../lib/query/agent';
import { listBox } from './channel-copy-line';

type Switch = 'enabled' | 'allowAllContacts';

/** Who may start a conversation without the owner's approval, by kind. */
const admitsDetail = (channel: Channel) =>
  channel.type === 'api'
    ? 'New senders reach the agent without your approval. Rooms still ask.'
    : channel.type === 'whatsapp-business'
      ? 'New people chat without your approval. Blocked contacts stay blocked.'
      : 'New people chat privately without your approval. Groups still ask.';

/**
 * A channel's own settings: whether the agent answers there at all, whether strangers need the
 * owner's approval first, and — on a chat app — how it asks for decisions. A switch moves the
 * moment it is pressed while the gateway is told; refused, it goes back to what the gateway holds.
 */
export function ChannelSwitches({
  channel,
  actions: { api, mutate },
  onEditMessages,
}: {
  channel: Channel;
  actions: SectionActions;
  /** Absent where the channel has no wording of its own: an API server's callers are programs. */
  onEditMessages?: () => void;
}) {
  const profile = useAgent();
  // What was pressed and not yet answered, over what the gateway last said.
  const [pressed, setPressed] = useState<Partial<Record<Switch, boolean>>>({});

  const flip = async (key: Switch, on: boolean, message: string) => {
    setPressed((current) => ({ ...current, [key]: on }));
    await mutate(
      () =>
        api.updateChannel(
          profile.id,
          channel.id,
          key === 'enabled' ? { enabled: on } : { allowAllContacts: on },
        ),
      message,
    );
    // Answered either way: what the gateway holds now is shown, the new value or the old one.
    setPressed(({ [key]: _settled, ...rest }) => rest);
  };

  return (
    <div className={listBox}>
      <Toggle
        label="Channel enabled"
        detail="Off, the agent ignores what arrives here and sends nothing; it is not answered later."
        checked={pressed.enabled ?? channel.enabled ?? true}
        onCheckedChange={(on) =>
          void flip(
            'enabled',
            on,
            on
              ? 'Channel enabled. Messages received while it was off are not answered.'
              : 'Channel disabled.',
          )
        }
      />
      <Toggle
        label={admitsAll(channel.type)}
        detail={admitsDetail(channel)}
        checked={pressed.allowAllContacts ?? channel.allowAllContacts ?? false}
        onCheckedChange={(on) =>
          void flip(
            'allowAllContacts',
            on,
            channel.type === 'api' ? 'Sender permissions updated.' : 'Contact permissions updated.',
          )
        }
      />
      {onEditMessages && (
        <SettingsRow title="Messages" description="How the agent asks for approval or an answer.">
          <Action tone="outline" size="small" aria-label="Edit messages" onClick={onEditMessages}>
            Edit
          </Action>
        </SettingsRow>
      )}
    </div>
  );
}
