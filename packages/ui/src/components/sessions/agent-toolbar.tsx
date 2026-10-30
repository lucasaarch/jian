'use client';

import type { ReactNode } from 'react';
import { StatusPill, SwitchControl } from '../../kit';
import type { Channel, Contact, Session } from '../../lib/api';
import type { SectionActions } from '../props';
import { ContextRing } from './context-ring';
import { SessionModel } from './model-picker';
import { SessionProtection } from './protection-menu';

/**
 * Where a chat has its composer, a channel's conversation has its settings: whether the agent
 * answers this contact, and on which model. A contact not yet approved, or a channel paused,
 * says so beside them; the objective and the listeners sit above, as they do over a composer.
 */
export function AgentToolbar({
  api,
  mutate,
  busy,
  profileId,
  session,
  messaging,
  contact,
  channels,
  badges,
  saved,
}: SectionActions & {
  profileId: string;
  session: Session;
  /** A WhatsApp or Telegram conversation, where the agent's replies can be turned off. */
  messaging: boolean;
  contact: Contact | undefined;
  channels: Channel[];
  badges: ReactNode;
  saved: () => void;
}) {
  const paused =
    messaging &&
    contact &&
    channels.some((channel) => channel.id === contact.channelId && channel.enabled === false);

  return (
    <section className="agent-toolbar" aria-label="Agent settings for this conversation">
      {/* Above the box at its right, as over the composer: the objective and the listeners. */}
      {badges && <div className="agent-toolbar-context">{badges}</div>}
      <div className="agent-toolbar-box">
        {/* No Compact here: what is written in a channel's conversation can reach its contact,
            and the gateway compacts on its own anyway. */}
        <ContextRing profileId={profileId} sessionId={session.id} />
        <SessionProtection
          api={api}
          profileId={profileId}
          session={session}
          align="start"
          saved={saved}
        />
        <SessionModel
          api={api}
          profileId={profileId}
          session={session}
          channel={messaging}
          className="composer-model-control"
          menuAlign="start"
          saved={saved}
        />
        <span className="grow" />
        {paused && <StatusPill tone="warn">Channel paused</StatusPill>}
        {contact && contact.status !== 'approved' && (
          <StatusPill>Contact {contact.status}</StatusPill>
        )}
        {messaging && contact && (
          <div className="agent-toolbar-switch">
            <span aria-hidden="true">
              AI<span className="agent-toolbar-switch-word"> replies</span>
            </span>
            <SwitchControl
              label={`AI replies for ${contact.displayName ?? contact.actorId}`}
              checked={contact.aiEnabled ?? true}
              disabled={busy}
              onCheckedChange={(aiEnabled) =>
                void mutate(
                  () => api.updateContact(profileId, contact.id, { aiEnabled }),
                  aiEnabled
                    ? 'AI replies are on for this contact. Messages paused before are not replayed.'
                    : 'AI replies are off for this contact, queued replies included.',
                )
              }
            />
          </div>
        )}
      </div>
    </section>
  );
}
