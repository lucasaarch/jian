import {
  Atom,
  FileText,
  Globe,
  type LucideIcon,
  Presentation,
  Sheet,
  Workflow,
} from 'lucide-react';
import type { SessionArtifact } from '../../../lib/api';
import { TYPE_NAME } from './source';

type Listed = Pick<SessionArtifact, 'type'>;

const ICON: Record<SessionArtifact['type'], LucideIcon> = {
  html: Globe,
  react: Atom,
  markdown: FileText,
  mermaid: Workflow,
  diagram: Workflow,
  deck: Presentation,
  sheet: Sheet,
};

/** The kind of an Artifact as the owner reads it in the list. */
export const kindName = (artifact: Listed) => TYPE_NAME[artifact.type];

/**
 * The tint a kind is drawn in where it stands for the Artifact itself: a card with no picture of
 * its own, a shortcut that makes one. Tints of the kit's own colours, which here say nothing
 * about how anything stands; two kinds may share one, and are told apart by their icon.
 */
export const KIND_TINT: Record<SessionArtifact['type'], string> = {
  deck: 'bg-warn/15 text-warn',
  markdown: 'bg-accent/15 text-accent',
  html: 'bg-good/15 text-good',
  react: 'bg-merged/15 text-merged',
  mermaid: 'bg-good/15 text-good',
  diagram: 'bg-good/15 text-good',
  sheet: 'bg-good/15 text-good',
};

/**
 * The icon that says what kind an Artifact is, beside its name in a list. Larger and in the
 * colour of what it stands on where it is the whole picture of one (`className`).
 */
export function KindIcon({
  artifact,
  size = 16,
  className = 'text-muted',
}: {
  artifact: Listed;
  size?: number;
  className?: string;
}) {
  const Icon = ICON[artifact.type];

  return <Icon size={size} aria-hidden="true" className={`shrink-0 ${className}`} />;
}
