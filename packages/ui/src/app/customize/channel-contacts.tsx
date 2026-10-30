'use client';

import { useState } from 'react';
import {
  channelContacts,
  contactActions,
  contactName,
  requestNote,
  roomLine,
  roommates,
} from '../../components/channels/contacts';
import type { SectionActions } from '../../components/props';
import { Action, InfoTip, StatusPill, SwitchControl } from '../../kit';
import type { Channel, Contact } from '../../lib/api';
import { useAgent, useContacts, useGroups } from '../../lib/query/agent';
import { listBox } from './channel-copy-line';

type Answers = ReturnType<typeof contactActions>;

/**
 * Who this channel reaches: its groups and its people, a line each, those waiting on the owner
 * first. Nobody has written yet, nothing is shown. Meta's channel has no groups.
 */
export function ChannelContacts({
  channel,
  actions,
}: {
  channel: Channel;
  actions: SectionActions;
}) {
  const profile = useAgent();
  const contacts = useContacts();
  // The rooms the gateway knows, with the agents in them; distinct from this channel's contacts.
  const rooms = useGroups();
  const answers = contactActions(actions, profile.id, channel);
  // What was pressed on a contact's switch and not yet answered, over what the gateway holds.
  const [pressed, setPressed] = useState<Record<string, boolean>>({});
  const mine = channelContacts(contacts, channel);
  const groups =
    channel.type === 'whatsapp-business' ? [] : mine.filter((item) => item.scope === 'group');
  const people = mine.filter((item) => item.scope !== 'group');

  const trust = async (contact: Contact, canApprove: boolean) => {
    setPressed((current) => ({ ...current, [contact.id]: canApprove }));
    await answers.trust(contact, canApprove);
    // Answered either way: what the gateway holds now is shown, the new value or the old one.
    setPressed(({ [contact.id]: _settled, ...rest }) => rest);
  };

  const line = (contact: Contact) => (
    <ContactLine
      key={contact.id}
      channel={channel}
      contact={contact}
      answers={answers}
      busy={actions.busy}
      canApprove={pressed[contact.id] ?? contact.canApprove ?? false}
      onTrust={(on) => void trust(contact, on)}
      {...(contact.scope === 'group' ? { room: roommates(contact, rooms, profile.id) } : {})}
    />
  );

  return (
    <>
      {groups.length > 0 && (
        <section className="grid gap-2">
          <h3 className="px-1 text-xs font-medium text-muted">Groups</h3>
          <div className={listBox}>{groups.map(line)}</div>
        </section>
      )}
      {people.length > 0 && (
        <section className="grid gap-2">
          <h3 className="px-1 text-xs font-medium text-muted">
            {channel.type === 'api' ? 'Senders' : 'Contacts'}
          </h3>
          <div className={listBox}>{people.map(line)}</div>
        </section>
      )}
    </>
  );
}

/**
 * One contact: its name and its answers. A request carries what it said, since that is what the
 * owner decides on. Approving actions is trust beyond talking to the agent — it runs what the
 * agent asked to do — and in a room anyone's yes counts; an API server's senders have no chat
 * to approve from.
 */
function ContactLine({
  channel,
  contact,
  answers,
  busy,
  canApprove,
  onTrust,
  room,
}: {
  channel: Channel;
  contact: Contact;
  answers: Answers;
  busy: boolean;
  canApprove: boolean;
  onTrust: (canApprove: boolean) => void;
  /** For a group, the other agents of this installation in it. */
  room?: { name: string }[];
}) {
  const name = contactName(contact);
  const said =
    contact.scope === 'group'
      ? 'Added the agent to this group. Approving covers everyone in it.'
      : contact.message;

  return (
    <div className="grid gap-1 px-3.5 py-2.5">
      <div className="flex min-h-7 items-center gap-2">
        <span className="min-w-0 truncate text-[13px] text-ink">{name}</span>
        {contact.status === 'pending' && <StatusPill tone="warn">Waiting</StatusPill>}
        {contact.status === 'blocked' && <StatusPill>Revoked</StatusPill>}
        {room && room.length > 0 && (
          <span title={roomLine(room)}>
            <StatusPill>{room.length + 1} agents</StatusPill>
          </span>
        )}
        <span className="flex-1" />
        {contact.status === 'pending' && (
          <>
            <InfoTip label="What approving does">{requestNote(channel, contact)}</InfoTip>
            <Action
              tone="quiet"
              size="small"
              aria-label={`Decline ${name}`}
              disabled={busy}
              onClick={() => void answers.refuse(contact)}
            >
              Decline
            </Action>
            <Action
              tone="outline"
              size="small"
              aria-label={`Approve ${name}`}
              disabled={busy}
              onClick={() => void answers.approve(contact)}
            >
              Approve
            </Action>
          </>
        )}
        {contact.status === 'approved' && (
          <>
            {channel.type !== 'api' && (
              <span className="flex items-center gap-1.5 text-xs text-muted">
                Can approve
                <SwitchControl
                  label={`${name} can approve actions`}
                  checked={canApprove}
                  onCheckedChange={onTrust}
                />
              </span>
            )}
            <Action
              tone="quiet"
              size="small"
              aria-label={`Revoke ${name}`}
              disabled={busy}
              onClick={() => void answers.refuse(contact)}
            >
              Revoke
            </Action>
          </>
        )}
        {contact.status === 'blocked' && (
          <Action
            tone="outline"
            size="small"
            aria-label={`Approve ${name} again`}
            disabled={busy}
            onClick={() => void answers.approve(contact)}
          >
            Approve again
          </Action>
        )}
      </div>
      {contact.status === 'pending' && said && (
        <p className="line-clamp-2 text-xs leading-snug text-muted">{said}</p>
      )}
    </div>
  );
}
