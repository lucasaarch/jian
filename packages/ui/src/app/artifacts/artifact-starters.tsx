'use client';

import { KIND_TINT, KindIcon } from '../../components/sessions/artifacts/kind';
import { TYPE_NAME } from '../../components/sessions/artifacts/source';
import { SectionHeading } from '../../kit';
import type { SessionArtifact } from '../../lib/api';

/**
 * What the agent makes when asked, each with the words a new conversation opens on: the start
 * of a request the owner finishes, so each ends where the subject goes.
 */
const STARTERS: { type: SessionArtifact['type']; prompt: string }[] = [
  { type: 'deck', prompt: 'Create slides as an Artifact about ' },
  { type: 'markdown', prompt: 'Write a document as an Artifact about ' },
  { type: 'sheet', prompt: 'Make a spreadsheet as an Artifact of ' },
  { type: 'html', prompt: 'Build a web page as an Artifact that ' },
  { type: 'react', prompt: 'Build a React component as an Artifact that ' },
  { type: 'mermaid', prompt: 'Draw a Mermaid diagram as an Artifact of ' },
];

/**
 * Shortcuts, one for each kind the agent makes, all in sight: a grid of tiles at least 9rem wide,
 * six to a row across the page's full width and fewer as it narrows, never a row scrolled
 * sideways. `narrow`, in the Inspector, they are smaller tiles at least 5rem wide that stretch to
 * fill the row: four to a row in its usual width, all of them in one when it is wide. One begins
 * the request where it is sent from (`onStart`); nothing is sent until the owner finishes it.
 */
export function ArtifactStarters({
  onStart,
  narrow = false,
}: {
  onStart: (prompt: string) => void;
  narrow?: boolean;
}) {
  return (
    <section aria-label="Create something new" className="grid min-w-0 grid-cols-1 gap-2">
      <SectionHeading title="Create something new" />
      <div
        className={
          narrow
            ? 'grid grid-cols-[repeat(auto-fit,minmax(5rem,1fr))] gap-2'
            : 'grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3'
        }
      >
        {STARTERS.map(({ type, prompt }) => (
          <button
            key={type}
            type="button"
            onClick={() => onStart(prompt)}
            className="group grid min-w-0 grid-cols-1 gap-1.5 text-left outline-none"
          >
            <span
              className={`grid ${narrow ? 'h-12' : 'h-16'} place-items-center rounded-xl border border-glass-edge transition-opacity group-hover:opacity-80 group-focus-visible:ring-2 group-focus-visible:ring-ink ${KIND_TINT[type]}`}
            >
              <KindIcon artifact={{ type }} size={narrow ? 18 : 22} className="" />
            </span>
            <span className="truncate px-0.5 text-xs text-muted transition-colors group-hover:text-ink">
              {TYPE_NAME[type]}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
