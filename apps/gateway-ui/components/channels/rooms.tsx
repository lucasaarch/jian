'use client';

import { Users } from 'lucide-react';
import type { SectionProps } from '../props';
import { Badge } from '../ui';
import { kinds } from './kinds';

const agents = (count: number) => (count === 1 ? '1 agent' : `${count} agents`);

export function Rooms({ profile, data }: SectionProps) {
  const rooms = data.groups.filter((group) =>
    group.profiles.some((item) => item.status === 'approved'),
  );

  if (!rooms.length) {
    return null;
  }

  return (
    <section className="subsection">
      <h2>Groups</h2>
      <div className="resource-list">
        {rooms.map((room) => (
          <div className="resource-row" key={`${room.type}:${room.chatId}`}>
            <div className={`resource-icon ${room.type}`}>
              <Users size={20} />
            </div>
            <div className="grow">
              <h3>{room.name ?? room.chatId}</h3>
              <p>
                {kinds.find((kind) => kind.type === room.type)?.name} ·{' '}
                {room.profiles
                  .filter((item) => item.status === 'approved')
                  .map((item) =>
                    item.profileId === profile.id ? `${item.name} (this one)` : item.name,
                  )
                  .join(', ')}
              </p>
            </div>
            <Badge
              tone={
                room.profiles.some((item) => item.profileId === profile.id) ? 'good' : 'neutral'
              }
            >
              {agents(room.profiles.filter((item) => item.status === 'approved').length)}
            </Badge>
          </div>
        ))}
      </div>
      <p className="note">
        An agent reads everything said in a group and answers only when someone mentions it or
        replies to it. A conversation between agents is capped in turns, and starts over when a
        person writes.
      </p>
    </section>
  );
}
