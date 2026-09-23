'use client';

import { ShieldQuestion, UserCheck, UserX } from 'lucide-react';
import type { Contact } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button } from '../ui';
import { kinds } from './kinds';

export function Requests({ profile, data, api, mutate, busy }: SectionProps) {
  const pending = data.contacts.filter((contact) => contact.status === 'pending');

  if (!pending.length) {
    return null;
  }

  const decide = (contact: Contact, approve: boolean) =>
    mutate(
      () =>
        approve
          ? api.approveContact(profile.id, contact.id)
          : api.blockContact(profile.id, contact.id),
      approve
        ? 'Contact approved. The message that was waiting went to the agent.'
        : 'Contact blocked.',
    );

  return (
    <section className="request-panel">
      <header>
        <ShieldQuestion size={20} />
        <div className="grow">
          <h2>Contact requests</h2>
          <p>Someone new wrote. The agent answers only after you approve them.</p>
        </div>
        <Badge tone="warn">{pending.length} waiting</Badge>
      </header>
      {pending.map((contact) => (
        <article className="request-row" key={contact.id}>
          <div className="grow">
            <h3>
              {contact.scope === 'group' ? 'Room: ' : ''}
              {contact.displayName ?? contact.actorId}
            </h3>
            <small>
              {kinds.find((kind) => kind.type === contact.type)?.name} · {contact.actorId} ·{' '}
              {date(contact.createdAt)}
            </small>
            <p className="request-message">
              {contact.scope === 'group'
                ? 'Approving covers the whole room. Inside it the agent answers only when someone writes its name.'
                : (contact.message ?? 'No message waiting.')}
            </p>
          </div>
          <div className="row-actions">
            <Button variant="secondary" disabled={busy} onClick={() => void decide(contact, true)}>
              <UserCheck size={16} />
              Approve
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              aria-label={`Block ${contact.actorId}`}
              onClick={() => void decide(contact, false)}
            >
              <UserX size={17} />
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
