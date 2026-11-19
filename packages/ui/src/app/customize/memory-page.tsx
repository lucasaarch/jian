'use client';

import { Brain, Copy, Trash2, Zap } from 'lucide-react';
import { useId, useState } from 'react';
import { MEMORY_CONTENT_LIMIT, type memoryActions } from '../../components/memories/memory-actions';
import { copy } from '../../components/sessions/artifacts/source';
import { Action, BackLink, MenuDivider, MenuEntry, MultiSelectField, TextArea } from '../../kit';
import type { Memory, Project } from '../../lib/api';
import { LOCALE, until } from '../../lib/format';
import {
  Detail,
  MoreMenu,
  PluginDetails,
  PluginEditActions,
  PluginHeader,
  pluginColumns,
} from '../plugins/plugin-page';
import { MemoryLinks } from './memory-links';

const day = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const moment = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** A memory's mark: a bolt for a flash one, which goes by itself, a brain for one kept. */
export function MemoryIcon({ memory, size }: { memory: Memory; size: number }) {
  return memory.expiresAt ? <Zap size={size} /> : <Brain size={size} />;
}

/** A column of reading: lines short enough to follow, whatever the page's own width. */
const reading = 'grid min-w-0 max-w-[44rem] grid-cols-1 gap-6';

type Props = {
  /** The key the page was opened for; the memory itself when it is still kept. */
  name: string;
  memory?: Memory;
  all: Memory[];
  projects: Project[];
  busy: boolean;
  actions: ReturnType<typeof memoryActions>;
  onBack: () => void;
  /** Opens a linked memory in this one's place. */
  follow: (key: string) => void;
  /** Asks to confirm, then forgets it. */
  onForget: (memory: Memory) => void;
};

/**
 * One memory, on a page of its own in the list's place, as a skill has under Plugins: its text,
 * rewritten by the owner from Edit; what it is recalled with and the projects it is pinned to,
 * which change at once; and beside them what is known about it. A memory that is not there, or
 * no longer — forgotten, or a flash one past its end — is said so with the way back.
 */
export function MemoryPage({
  name,
  memory,
  all,
  projects,
  busy,
  actions,
  onBack,
  follow,
  onForget,
}: Props) {
  const form = useId();
  const [editing, setEditing] = useState(false);

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="grid grid-cols-1 gap-3">
        <BackLink onClick={onBack}>Memories</BackLink>
        {memory && (
          <PluginHeader
            titleId="memory-title"
            icon={<MemoryIcon memory={memory} size={20} />}
            name={memory.key}
            verified={false}
            subline={memory.expiresAt ? 'Flash memory' : 'Permanent memory'}
          >
            {editing ? (
              <PluginEditActions form={form} busy={busy} onCancel={() => setEditing(false)} />
            ) : (
              <>
                <Action tone="outline" size="field" onClick={() => setEditing(true)}>
                  Edit
                </Action>
                <MoreMenu>
                  <MenuEntry
                    icon={<Copy size={14} />}
                    onClick={() => void copy(memory.content, 'Memory')}
                  >
                    Copy text
                  </MenuEntry>
                  <MenuDivider />
                  <MenuEntry
                    icon={<Trash2 size={14} />}
                    danger
                    disabled={busy}
                    onClick={() => onForget(memory)}
                  >
                    Forget
                  </MenuEntry>
                </MoreMenu>
              </>
            )}
          </PluginHeader>
        )}
      </div>
      {memory ? (
        <div className="@container">
          <div className={pluginColumns}>
            <div className={reading}>
              {editing ? (
                <MemoryEditForm
                  // A new opening, or a version written meanwhile, starts from what is stored.
                  key={memory.version}
                  id={form}
                  memory={memory}
                  onSave={(content) =>
                    void actions.save(memory, content).then((ok) => {
                      if (ok) setEditing(false);
                    })
                  }
                />
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">
                  {memory.content}
                </p>
              )}
              <MemoryLinks
                memory={memory}
                all={all}
                busy={busy}
                link={(key) => void actions.link(memory, key)}
                unlink={(key) => void actions.unlink(memory, key)}
                follow={follow}
              />
              {projects.length > 0 && (
                <MultiSelectField
                  label="Projects"
                  hint="In a chat on one of these, the agent reads this memory first."
                  placeholder="Not pinned to a project"
                  values={memory.projectIds ?? []}
                  options={projects.map((project) => ({ value: project.id, label: project.name }))}
                  onValuesChange={(ids) => void actions.setProjects(memory, ids)}
                />
              )}
            </div>
            <PluginDetails>
              <Detail label="Version">
                <span>
                  v{memory.version}{' '}
                  <span className="text-muted">
                    · updated {day.format(new Date(memory.updatedAt))}
                  </span>
                </span>
              </Detail>
              <Detail label="Written by">
                {memory.sourceSessionId ? 'The agent, in a conversation' : 'You'}
              </Detail>
              {memory.expiresAt && (
                <Detail label="Expires">
                  <span>
                    in {until(memory.expiresAt)}{' '}
                    <span className="text-muted">
                      · {moment.format(new Date(memory.expiresAt))}
                    </span>
                  </span>
                </Detail>
              )}
            </PluginDetails>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">
          No memory named <span className="text-ink">{name}</span>. A flash memory is deleted when
          it expires.
        </p>
      )}
    </div>
  );
}

/** The text as a field, while the owner rewrites it. Sent by the header's Save, named by `id`. */
function MemoryEditForm({
  id,
  memory,
  onSave,
}: {
  id: string;
  memory: Memory;
  onSave: (content: string) => void;
}) {
  const [content, setContent] = useState(memory.content);

  return (
    <form
      id={id}
      aria-label={`Edit ${memory.key}`}
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = content.trim();
        if (trimmed) onSave(trimmed);
      }}
    >
      <TextArea
        label="Memory"
        hint={`${content.length} of ${MEMORY_CONTENT_LIMIT} characters`}
        rows={10}
        maxLength={MEMORY_CONTENT_LIMIT}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
    </form>
  );
}
