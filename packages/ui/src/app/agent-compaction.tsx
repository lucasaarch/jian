'use client';

import { type CompactAt, MAX_COMPACT_AT, MIN_COMPACT_AT } from '@jian/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { RowInput, Segmented, SettingsGroup, SettingsRow } from '../kit';
import type { Profile } from '../lib/api';
import { type SaveState, useAutoSave } from '../lib/auto-save';
import { saveProfile } from '../lib/profile-saves';
import { queries } from '../lib/query/profile';

/** Sizes a long conversation is often held to, in tokens. */
const PRESETS = [200_000, 400_000, 600_000];

/** What a set size starts from when the owner first picks one. */
const FIRST_SIZE = PRESETS[0] ?? 200_000;

type Draft = { mode: 'auto' | 'set'; tokens: string };

const tokensOf = (text: string) => Number(text.replaceAll(/[\s,._]/g, ''));

/** Why the gateway would refuse the size as typed, or nothing when it would take it. */
function refusal(draft: Draft): string | undefined {
  if (draft.mode === 'auto') return undefined;
  const tokens = tokensOf(draft.tokens);
  if (!draft.tokens.trim() || !Number.isInteger(tokens)) return 'Write a whole number of tokens';
  if (tokens < MIN_COMPACT_AT) return `At least ${MIN_COMPACT_AT.toLocaleString('en')} tokens`;
  if (tokens > MAX_COMPACT_AT) return `At most ${MAX_COMPACT_AT.toLocaleString('en')} tokens`;
  return undefined;
}

/** The size as typed, when the gateway would take it. */
const sizeOf = (draft: Draft): number | undefined =>
  draft.mode === 'set' && !refusal(draft) ? tokensOf(draft.tokens) : undefined;

const chosen = (draft: Draft): CompactAt | undefined =>
  draft.mode === 'auto' ? 'auto' : sizeOf(draft);

function saveNote(status: SaveState, draft: Draft) {
  const refused = refusal(draft);
  if (refused) return <span className="text-bad">{refused}</span>;
  if (status.state === 'saving') return 'Saving…';
  if (status.state === 'saved') return 'Saved';
  if (status.state === 'failed') return <span className="text-bad">{status.reason}</span>;
  return undefined;
}

/**
 * When the agent's conversations are summarised: near the end of the model's window, or at a
 * size the owner sets. Saved as it changes, like the identity above it.
 */
export function AgentCompaction({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const ids = useId();
  const stored = profile.contextPolicy.compactAt ?? 'auto';
  const [draft, setDraft] = useState<Draft>({
    mode: stored === 'auto' ? 'auto' : 'set',
    tokens: (stored === 'auto' ? FIRST_SIZE : stored).toLocaleString('en'),
  });
  const status = useAutoSave(
    draft,
    async (next) => {
      const compactAt = chosen(next);
      if (compactAt === undefined) return;
      // In turn with the identity's saves, against the newest version. The gateway takes the
      // policy whole: the rest goes back as it stands.
      const saved = await saveProfile(profile, {
        contextPolicy: { ...profile.contextPolicy, compactAt },
      });
      client.setQueryData(queries.profiles().queryKey, (profiles = []) =>
        profiles.map((item) => (item.id === saved.id ? saved : item)),
      );
    },
    (next) => chosen(next) !== undefined,
  );
  const id = (part: string) => `${ids}-${part}`;
  const size = sizeOf(draft);

  return (
    <SettingsGroup
      title="Conversations"
      note={<span role="status">{saveNote(status, draft)}</span>}
    >
      <SettingsRow
        title="Compact conversations"
        description="Compacting later keeps more of the conversation word for word, but each step costs more."
        labelId={id('compact')}
        descriptionId={id('compact-detail')}
        below={
          draft.mode === 'set' && (
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                label="Sizes"
                value={String(size ?? '')}
                onChange={(value) =>
                  setDraft({ mode: 'set', tokens: Number(value).toLocaleString('en') })
                }
                options={PRESETS.map((tokens) => ({
                  value: String(tokens),
                  label: `${tokens / 1000}K`,
                }))}
              />
              <span id={id('size')} className="text-xs text-muted">
                Size in tokens
              </span>
              <RowInput
                labelledBy={id('size')}
                describedBy={id('size-detail')}
                className="w-32"
                inputMode="numeric"
                autoComplete="off"
                value={draft.tokens}
                onChange={(event) => setDraft({ mode: 'set', tokens: event.target.value })}
              />
              <span id={id('size-detail')} className="text-xs text-muted">
                Near the limit instead, if the model reaches that first.
              </span>
            </div>
          )
        }
      >
        <Segmented
          label="Compact conversations"
          value={draft.mode}
          onChange={(mode) => setDraft((current) => ({ ...current, mode }))}
          options={[
            { value: 'auto', label: 'Near the limit' },
            { value: 'set', label: 'At a set size' },
          ]}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
