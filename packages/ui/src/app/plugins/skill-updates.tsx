'use client';

import { useState } from 'react';
import { useSkillUpstream } from '../../components/skills/skill-list';
import { Action, ConfirmDialog, InfoTip } from '../../kit';
import type { GatewayApi, LibrarySkill } from '../../lib/api';

/**
 * Whether a skill copied from GitHub still says what its source does, asked when its page
 * opens, and the button that copies it again. The copy replaces what the library holds, so a
 * skill edited here since it was imported asks first: those edits are what would be lost.
 */
export function SkillUpdates({
  skill,
  importedAt,
  api,
  busy,
  update,
}: {
  skill: LibrarySkill;
  /** When it was last copied from its source. */
  importedAt: string;
  api: GatewayApi;
  busy: boolean;
  /** Copies it from its source again; false when that failed, after saying so. */
  update: () => Promise<boolean>;
}) {
  const upstream = useSkillUpstream(api, skill.name);
  const [asking, setAsking] = useState(false);
  // An import stamps both with the same instant, so a later change is the owner's or an agent's.
  const edited = Date.parse(skill.updatedAt) > Date.parse(importedAt);

  return (
    <>
      {upstream.isFetching ? (
        <span className="text-muted">Checking…</span>
      ) : upstream.isError ? (
        <>
          <span>Could not reach GitHub</span>
          {upstream.error instanceof Error && (
            <InfoTip label="What went wrong">{upstream.error.message}</InfoTip>
          )}
          <Action tone="quiet" size="small" onClick={() => void upstream.refetch()}>
            Try again
          </Action>
        </>
      ) : upstream.data?.changed ? (
        <>
          <span>Update available</span>
          <Action
            tone="outline"
            size="small"
            busy={busy && !asking}
            onClick={() => (edited ? setAsking(true) : void update())}
          >
            Update
          </Action>
          {edited && (
            <span className="basis-full text-xs leading-snug text-muted">
              Edited here since the import. Updating replaces those edits.
            </span>
          )}
        </>
      ) : (
        <span>Up to date</span>
      )}
      {/* Outside the answer above, which changes under it once the update is in. */}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Replace the edits to ${skill.name}?`}
        action="Update skill"
        busy={busy}
        run={() =>
          void update().then((ok) => {
            if (ok) setAsking(false);
          })
        }
      >
        It was edited here after it was imported. Updating copies it from GitHub again, over those
        edits. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
