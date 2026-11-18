'use client';

import { KIND_TINT, KindIcon } from '../../components/sessions/artifacts/kind';
import { TYPE_NAME } from '../../components/sessions/artifacts/source';
import { ScrollStrip, SectionHeading } from '../../kit';
import type { SessionArtifact } from '../../lib/api';

/**
 * What the agent makes when asked, each with the words a new conversation opens on: the start
 * of a request the owner finishes, so each ends where the subject goes. A file is not among
 * them: the agent keeps one it was given, it is not asked to make one.
 */
const STARTERS: { type: Exclude<SessionArtifact['type'], 'file'>; prompt: string }[] = [
  { type: 'deck', prompt: 'Create a deck of slides as an Artifact about ' },
  { type: 'markdown', prompt: 'Write a document as an Artifact about ' },
  { type: 'html', prompt: 'Build a web page as an Artifact that ' },
  { type: 'react', prompt: 'Build a React component as an Artifact that ' },
  { type: 'svg', prompt: 'Draw an SVG picture as an Artifact of ' },
  { type: 'mermaid', prompt: 'Draw a Mermaid diagram as an Artifact of ' },
];

/**
 * A row of shortcuts, one for each kind the agent makes. One starts a new conversation with the
 * request already begun in its field; nothing is sent until the owner finishes and sends it.
 */
export function ArtifactStarters({ onStart }: { onStart: (prompt: string) => void }) {
  return (
    <section aria-label="Create something new" className="grid min-w-0 grid-cols-1 gap-2">
      <SectionHeading title="Create something new" />
      {/* Room around the row for a focus ring, which the strip would otherwise cut. */}
      <ScrollStrip className="-m-1 flex gap-3 p-1">
        {STARTERS.map(({ type, prompt }) => (
          <button
            key={type}
            type="button"
            onClick={() => onStart(prompt)}
            className="group grid w-28 shrink-0 grid-cols-1 gap-1.5 text-left outline-none"
          >
            <span
              className={`grid h-16 place-items-center rounded-xl border border-glass-edge transition-opacity group-hover:opacity-80 group-focus-visible:ring-2 group-focus-visible:ring-ink ${KIND_TINT[type]}`}
            >
              <KindIcon artifact={{ type }} size={22} className="" />
            </span>
            <span className="truncate px-0.5 text-xs text-muted transition-colors group-hover:text-ink">
              {TYPE_NAME[type]}
            </span>
          </button>
        ))}
      </ScrollStrip>
    </section>
  );
}
