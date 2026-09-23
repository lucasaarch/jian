'use client';

import { MessageSquare, Search } from 'lucide-react';
import { useState } from 'react';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Empty, SectionHeading } from '../ui';
import { Select } from '../ui/select';
import { History } from './history';

const channelNames: Record<string, string> = {
  web: 'Painel (legado)',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  api: 'API',
};
export function Sessions({
  profile,
  data,
  api,
  initialSession,
}: SectionProps & { initialSession?: string }) {
  const [selected, setSelected] = useState(initialSession);
  const [channel, setChannel] = useState('');
  const [query, setQuery] = useState('');
  const channels = [...new Set(data.sessions.map((session) => session.channel))].sort();
  const filtered = [...data.sessions]
    .filter(
      (session) =>
        (!channel || session.channel === channel) &&
        `${session.title ?? ''} ${session.id} ${channelNames[session.channel] ?? session.channel}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = filtered.find((session) => session.id === selected) ?? filtered[0];
  return (
    <>
      <SectionHeading
        title="Sessions"
        description="The history of its conversations, grouped by channel."
      />
      {data.sessions.length ? (
        <>
          <div className="session-filters">
            <div className="search-field">
              <Search size={16} />
              <input
                aria-label="Search sessions"
                placeholder="Search by title or id…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Select
              aria-label="Filter by channel"
              value={channel}
              onValueChange={setChannel}
              options={[
                { value: '', label: 'Every channel' },
                ...channels.map((value) => ({ value, label: channelNames[value] ?? value })),
              ]}
            />
          </div>
          {filtered.length ? (
            <div className="sessions-layout">
              <aside className="session-list" aria-label="Sessions by channel">
                {channels.map((kind) => {
                  const group = filtered.filter((session) => session.channel === kind);
                  return (
                    group.length > 0 && (
                      <section key={kind}>
                        <h2 className="session-channel-heading">
                          {channelNames[kind] ?? kind}
                          <span>{group.length}</span>
                        </h2>
                        {group.map((session) => (
                          <div
                            className={`session-row ${active?.id === session.id ? 'selected' : ''}`}
                            key={session.id}
                          >
                            <button
                              type="button"
                              onClick={() => setSelected(session.id)}
                              aria-pressed={active?.id === session.id}
                            >
                              <MessageSquare size={16} />
                              <span>
                                <strong>{session.title || 'Untitled'}</strong>
                                <small>{date(session.createdAt)}</small>
                                <code>{session.id.slice(0, 8)}</code>
                              </span>
                            </button>
                          </div>
                        ))}
                      </section>
                    )
                  );
                })}
              </aside>
              {active && (
                <History
                  key={active.id}
                  api={api}
                  profileId={profile.id}
                  sessionId={active.id}
                  initialRun={data.activities
                    .filter((run) => run.sessionId === active.id)
                    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
                    .at(-1)}
                />
              )}
            </div>
          ) : (
            <Empty title="No session found">Try another title, id or channel.</Empty>
          )}
        </>
      ) : (
        <Empty title="No sessions yet">
          Conversations started through a channel are recorded here.
        </Empty>
      )}
    </>
  );
}
