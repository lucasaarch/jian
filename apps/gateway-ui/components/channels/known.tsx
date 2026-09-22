'use client';

import { MessageCircle, UserCheck, UserX } from 'lucide-react';
import type { SectionProps } from '../props';
import { Badge, Button } from '../ui';
import { kinds } from './kinds';

export function Known({ profile, data, api, mutate, busy }: SectionProps) {
  const known = data.contacts.filter(
    (contact) => contact.status !== 'pending' && contact.scope !== 'group',
  );

  if (!known.length) {
    return null;
  }

  return (
    <section className="subsection">
      <h2>Contatos</h2>
      <div className="resource-list">
        {known.map((contact) => (
          <div className="resource-row" key={contact.id}>
            <div className={`resource-icon ${contact.type}`}>
              <MessageCircle size={20} />
            </div>
            <div className="grow">
              <h3>{contact.displayName ?? contact.actorId}</h3>
              <p>
                {kinds.find((kind) => kind.type === contact.type)?.name} · {contact.actorId}
              </p>
            </div>
            <Badge tone={contact.status === 'approved' ? 'good' : 'neutral'}>
              {contact.status === 'approved' ? 'Aprovado' : 'Bloqueado'}
            </Badge>
            <div className="row-actions">
              {contact.status === 'approved' ? (
                <Button
                  variant="quiet"
                  disabled={busy}
                  aria-label={`Block ${contact.actorId}`}
                  onClick={() =>
                    void mutate(() => api.blockContact(profile.id, contact.id), 'Contact blocked.')
                  }
                >
                  <UserX size={17} />
                </Button>
              ) : (
                <Button
                  variant="quiet"
                  disabled={busy}
                  aria-label={`Approve ${contact.actorId}`}
                  onClick={() =>
                    void mutate(
                      () => api.approveContact(profile.id, contact.id),
                      'Contact approved.',
                    )
                  }
                >
                  <UserCheck size={17} />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
