'use client';

import { ArrowDownToLine, LoaderCircle, RefreshCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useSkillUpstream } from '../../components/skills/skill-list';
import { ConfirmDialog, iconButton } from '../../kit';
import type { GatewayApi, LibrarySkill } from '../../lib/api';

/**
 * The bar's round button inside a line of text: on the words' centre, and pulled in above and
 * below so the line stays as tall as its words.
 */
function InlineButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <span className="-my-1 ml-0.5 inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={onClick}
        className={iconButton}
      >
        {children}
      </button>
    </span>
  );
}

/** The answer and its button wrap as one, so the button never starts a line alone. */
const together = 'whitespace-nowrap';

/**
 * How the version line of a skill copied from GitHub ends: with nothing while its source still
 * says the same, asked when its page opens, and with the update and the button that takes it
 * once the source changed. The copy replaces what the library holds, so a skill edited here
 * since it was imported asks first: those edits are what would be lost.
 */
export function SkillUpdate({
  skill,
  importedAt,
  api,
  update,
}: {
  skill: LibrarySkill;
  /** When it was last copied from its source. */
  importedAt: string;
  api: GatewayApi;
  /** Copies it from its source again; false when that failed, after saying so. */
  update: () => Promise<boolean>;
}) {
  const upstream = useSkillUpstream(api, skill.name);
  const [asking, setAsking] = useState(false);
  const [updating, setUpdating] = useState(false);
  // An import stamps both with the same instant, so a later change is the owner's or an agent's.
  const edited = Date.parse(skill.updatedAt) > Date.parse(importedAt);
  const run = async () => {
    setUpdating(true);
    const ok = await update();
    setUpdating(false);
    return ok;
  };

  return (
    <>
      {upstream.isFetching ? null : upstream.isError ? (
        <span className="text-muted">
          {' · '}
          <span className={together}>
            Couldn’t check
            <InlineButton label="Check again" onClick={() => void upstream.refetch()}>
              <RefreshCw size={13} aria-hidden="true" />
            </InlineButton>
          </span>
        </span>
      ) : (
        upstream.data?.changed && (
          <>
            <span className="text-muted"> · </span>
            <span className={together}>
              Update available
              <InlineButton
                label="Update to the latest version"
                disabled={updating}
                onClick={() => (edited ? setAsking(true) : void run())}
              >
                {updating ? (
                  <LoaderCircle size={13} aria-hidden="true" className="animate-spin" />
                ) : (
                  <ArrowDownToLine size={13} aria-hidden="true" />
                )}
              </InlineButton>
            </span>
          </>
        )
      )}
      {/* Outside the answer above, which changes under it once the update is in. */}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Replace the edits to ${skill.name}?`}
        action="Update skill"
        busy={updating}
        run={() =>
          void run().then((ok) => {
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
