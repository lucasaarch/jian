'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { RowInput, RowTextArea, SettingsGroup, SettingsRow } from '../kit';
import type { Profile } from '../lib/api';
import { type SaveState, useAutoSave } from '../lib/auto-save';
import { panelApi } from '../lib/query/client';
import { queries } from '../lib/query/profile';

type Identity = { name: string; summary: string; instructions: string; boundaries: string };

/** The gateway keeps this many boundaries at most. */
const MAX_BOUNDARIES = 10;

/** Boundaries are written one to a line; blank lines are not rules. */
const rules = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** What a save is doing, said quietly above the card; nothing until the first change. */
function saveNote(status: SaveState, draft: Identity) {
  if (!draft.name.trim()) return <span className="text-bad">A name is needed</span>;
  if (!draft.instructions.trim()) return <span className="text-bad">Instructions are needed</span>;
  if (rules(draft.boundaries).length > MAX_BOUNDARIES) {
    return <span className="text-bad">Ten boundaries at most</span>;
  }
  if (status.state === 'saving') return 'Saving…';
  if (status.state === 'saved') return 'Saved';
  if (status.state === 'failed') return <span className="text-bad">{status.reason}</span>;
  return undefined;
}

/** Who the agent is and the rules it keeps, saved as they are typed. */
export function AgentIdentity({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const ids = useId();
  const [draft, setDraft] = useState<Identity>({
    name: profile.name,
    summary: profile.summary ?? '',
    instructions: profile.instructions,
    boundaries: profile.identity.boundaries.join('\n'),
  });
  // The version each save is made against: the newest, whether this screen saved it or the
  // agent edited itself meanwhile.
  const version = useRef(profile.version);
  version.current = Math.max(version.current, profile.version);

  const status = useAutoSave(
    draft,
    async (next) => {
      const saved = await panelApi().updateProfile(profile.id, {
        expectedVersion: version.current,
        name: next.name.trim(),
        summary: next.summary.trim(),
        instructions: next.instructions.trim(),
        // The rest of the identity is sent as it stands: the gateway takes it whole.
        identity: { ...profile.identity, boundaries: rules(next.boundaries) },
      });
      version.current = saved.version;
      client.setQueryData(queries.profiles().queryKey, (profiles = []) =>
        profiles.map((item) => (item.id === saved.id ? saved : item)),
      );
    },
    (next) =>
      Boolean(next.name.trim() && next.instructions.trim()) &&
      rules(next.boundaries).length <= MAX_BOUNDARIES,
  );
  const edit = (field: keyof Identity) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }));
  const id = (part: string) => `${ids}-${part}`;

  return (
    <SettingsGroup title="Identity" note={<span role="status">{saveNote(status, draft)}</span>}>
      <SettingsRow
        title="Name"
        description="Shown in the app and to the people it talks with."
        labelId={id('name')}
        descriptionId={id('name-detail')}
      >
        <RowInput
          labelledBy={id('name')}
          describedBy={id('name-detail')}
          value={draft.name}
          onChange={edit('name')}
          maxLength={100}
          autoComplete="off"
        />
      </SettingsRow>
      <SettingsRow
        title="Summary"
        description="One line on what it does."
        labelId={id('summary')}
        descriptionId={id('summary-detail')}
      >
        <RowInput
          labelledBy={id('summary')}
          describedBy={id('summary-detail')}
          value={draft.summary}
          onChange={edit('summary')}
          placeholder="Personal assistant"
          autoComplete="off"
        />
      </SettingsRow>
      <SettingsRow
        title="Instructions"
        description="What it is for and how it works. It reads them before every turn."
        labelId={id('instructions')}
        descriptionId={id('instructions-detail')}
        below={
          <RowTextArea
            labelledBy={id('instructions')}
            describedBy={id('instructions-detail')}
            value={draft.instructions}
            onChange={edit('instructions')}
            maxLength={8000}
            rows={10}
          />
        }
      />
      <SettingsRow
        title="Boundaries"
        description="Rules it must keep whatever it is asked, one to a line."
        labelId={id('boundaries')}
        descriptionId={id('boundaries-detail')}
        below={
          <RowTextArea
            labelledBy={id('boundaries')}
            describedBy={id('boundaries-detail')}
            value={draft.boundaries}
            onChange={edit('boundaries')}
            placeholder="Never share a customer's phone number."
            rows={3}
          />
        }
      />
    </SettingsGroup>
  );
}
