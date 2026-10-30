'use client';

import { Link2, Save, X } from 'lucide-react';
import { useState } from 'react';
import type { Memory } from '../../lib/api';
import { Button, Field, Modal } from '../ui';
import { Select } from '../ui/select';

/** The same bound the gateway puts on a memory and on its links. */
const CONTENT_LIMIT = 4000;
const LINK_LIMIT = 12;

/**
 * One memory, rewritten by the owner, and the memories it is recalled with. The text saves as a
 * new version against the one on screen, so an agent writing meanwhile is not overwritten; a
 * link changes the moment it is added or removed.
 */
export function MemoryEditor({
  memory,
  all,
  busy,
  close,
  save,
  link,
  unlink,
}: {
  memory: Memory;
  all: Memory[];
  busy: boolean;
  close: () => void;
  save: (content: string) => Promise<boolean>;
  link: (key: string) => Promise<boolean>;
  unlink: (key: string) => Promise<boolean>;
}) {
  const [content, setContent] = useState(memory.content);
  const links = memory.links ?? [];
  const candidates = all
    .filter((item) => item.key !== memory.key && !links.includes(item.key))
    .map((item) => ({ value: item.key, label: item.key, detail: item.content.slice(0, 80) }));

  return (
    <Modal
      title={memory.key}
      description={`Version ${memory.version}`}
      close={close}
      wide
      footer={
        <>
          <Button type="button" variant="quiet" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="memory-form"
            busy={busy}
            disabled={!content.trim() || content.trim() === memory.content}
          >
            <Save size={16} />
            Save
          </Button>
        </>
      }
    >
      <form
        id="memory-form"
        className="grid gap-5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await save(content.trim())) close();
        }}
      >
        <Field label="Content" hint={`${content.length} of ${CONTENT_LIMIT} characters`}>
          <textarea
            value={content}
            maxLength={CONTENT_LIMIT}
            rows={6}
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
        <section className="memory-editor-links" aria-labelledby="memory-links-title">
          <h3 id="memory-links-title">Recalled with</h3>
          <p>When this memory is relevant, these come with it.</p>
          {links.length > 0 && (
            <ul className="memory-links">
              {links.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    aria-label={`Unlink ${key}`}
                    disabled={busy}
                    onClick={() => void unlink(key)}
                  >
                    <Link2 size={12} />
                    {key}
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {candidates.length > 0 && links.length < LINK_LIMIT ? (
            <Select
              value=""
              placeholder="Link another memory"
              options={candidates}
              disabled={busy}
              onValueChange={(key) => void link(key)}
              aria-label="Link another memory"
            />
          ) : links.length >= LINK_LIMIT ? (
            <p className="note">A memory holds up to {LINK_LIMIT} links.</p>
          ) : null}
        </section>
      </form>
    </Modal>
  );
}
