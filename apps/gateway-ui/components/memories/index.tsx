'use client';

import { BookOpen, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Memory } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Button, Confirm, Empty, Field, SectionHeading } from '../ui';

export function Memories({ profile, data, api, mutate, busy }: SectionProps) {
  const [query, setQuery] = useState('');
  const [removing, setRemoving] = useState<Memory>();
  const terms = query.trim().toLowerCase();

  const found = data.memories.filter((item) =>
    terms ? `${item.key} ${item.content}`.toLowerCase().includes(terms) : true,
  );

  return (
    <>
      <SectionHeading
        title="Memories"
        description="What the agent kept across this profile’s conversations."
      />
      <div className="notice">
        <BookOpen size={18} />
        <p>
          Only the agent writes here, through its own tools. You read what it kept and delete what
          is wrong — a wrong memory repeats itself in every new session.
        </p>
      </div>
      <Field label="Search">
        <input
          type="search"
          value={query}
          placeholder="Key or content"
          onChange={(event) => setQuery(event.target.value)}
        />
      </Field>
      {found.length ? (
        <div className="memory-grid">
          {found.map((item) => (
            <article className="memory-card" key={item.key}>
              <header>
                <code>{item.key}</code>
                <Button
                  variant="quiet"
                  aria-label={`Delete ${item.key}`}
                  onClick={() => setRemoving(item)}
                >
                  <Trash2 size={16} />
                </Button>
              </header>
              <p>{item.content}</p>
              <small>
                Version {item.version} · {date(item.updatedAt)}
              </small>
            </article>
          ))}
        </div>
      ) : data.memories.length ? (
        <Empty title="Nothing found">No memory matches that search.</Empty>
      ) : (
        <Empty title="A place for what matters">
          The agent has kept nothing yet. What it records during conversations shows up here.
        </Empty>
      )}
      {removing && (
        <Confirm
          title="Delete this memory?"
          description="The agent stops reading this entry on its next runs. This cannot be undone."
          busy={busy}
          close={() => setRemoving(undefined)}
          confirm={async () => {
            if (await mutate(() => api.forget(profile.id, removing.key), 'Memory deleted.')) {
              setRemoving(undefined);
            }
          }}
        />
      )}
    </>
  );
}

/**
 * Import copies the instructions once; the repository is provenance, not a live link. Naming
 * that in the form keeps the owner from expecting a skill to follow upstream on its own.
 */
