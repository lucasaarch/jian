'use client';

import { type CompactAt, MIN_COMPACT_AT } from '@jian/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { RowInput, Segmented, SettingsGroup, SettingsRow } from '../kit';
import type { Profile } from '../lib/api';
import { type SaveState, useAutoSave } from '../lib/auto-save';
import { panelApi } from '../lib/query/client';
import { queries } from '../lib/query/profile';

/** The most the gateway takes, in tokens: more than any model's window. */
const MAX_COMPACT_AT = 20_000_000;

/** Sizes a long conversation is often held to, in tokens. */
const PRESETS = [200_000, 400_000, 600_000];

/** What a set size starts from when the owner first picks one. */
const FIRST_SIZE = PRESETS[0] ?? 200_000;

type Draft = { mode: 'auto' | 'set'; tokens: string };

const tokensOf = (text: string) => Number(text.replaceAll(/[\s,._]/g, ''));

/** The size as typed, when the gateway would take it. */
function sizeOf(draft: Draft): number | undefined {
  const tokens = tokensOf(draft.tokens);
  return Number.isInteger(tokens) && tokens >= MIN_COMPACT_AT && tokens <= MAX_COMPACT_AT
    ? tokens
    : undefined;
}

const chosen = (draft: Draft): CompactAt | undefined =>
  draft.mode === 'auto' ? 'auto' : sizeOf(draft);

function saveNote(status: SaveState, draft: Draft) {
  if (chosen(draft) === undefined) {
    return <span className="text-bad">At least {MIN_COMPACT_AT.toLocaleString('en')} tokens</span>;
  }
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
  // The version each save is made against: the newest, whoever saved it.
  const version = useRef(profile.version);
  version.current = Math.max(version.current, profile.version);

  const status = useAutoSave(
    draft,
    async (next) => {
      const compactAt = chosen(next);
      if (compactAt === undefined) return;
      const saved = await panelApi().updateProfile(profile.id, {
        expectedVersion: version.current,
        // The gateway takes the policy whole: the rest goes back as it stands.
        contextPolicy: { ...profile.contextPolicy, compactAt },
      });
      version.current = saved.version;
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
        description="Later, the agent keeps more of the conversation word for word, and each step costs more."
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
              <RowInput
                labelledBy={id('compact')}
                describedBy={id('compact-unit')}
                className="w-32"
                inputMode="numeric"
                autoComplete="off"
                value={draft.tokens}
                onChange={(event) => setDraft({ mode: 'set', tokens: event.target.value })}
              />
              <span id={id('compact-unit')} className="text-xs text-muted">
                tokens, or near the limit if the model reaches that first
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
