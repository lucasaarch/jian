import {
  Atom,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Globe,
  Image,
  type LucideIcon,
  Presentation,
  Shapes,
  Workflow,
} from 'lucide-react';
import type { SessionArtifact } from '../../../lib/api';
import { kindNames } from '../media';
import { languageOf } from '../preview';
import { TYPE_NAME } from './source';

type Listed = Pick<SessionArtifact, 'type' | 'file'>;

const ICON: Record<Exclude<SessionArtifact['type'], 'file'>, LucideIcon> = {
  html: Globe,
  react: Atom,
  markdown: FileText,
  svg: Shapes,
  mermaid: Workflow,
  deck: Presentation,
};

/** Documents read as pages of text, whatever wrote them. */
const WRITTEN = /pdf|markdown|plain|wordprocessing|msword|opendocument\.text|rtf/;

function fileIcon({ name, mimeType }: NonNullable<Listed['file']>): LucideIcon {
  const family = mimeType.split('/')[0];

  if (family === 'image') return Image;
  if (family === 'video') return FileVideo;
  if (family === 'audio') return FileAudio;
  if (mimeType === 'application/zip') return FileArchive;
  if (/spreadsheet|excel|csv/.test(mimeType)) return FileSpreadsheet;
  if (/presentation|powerpoint/.test(mimeType)) return Presentation;
  if (WRITTEN.test(mimeType)) return FileText;

  // What is left reads as code when its type or its name has a grammar.
  return languageOf(mimeType, name) ? FileCode : File;
}

/** The kind of an Artifact as the owner reads it in the list: a file's is its format. */
export function kindName(artifact: Listed) {
  if (artifact.type !== 'file') return TYPE_NAME[artifact.type];
  const type = artifact.file?.mimeType ?? '';

  if (type.startsWith('image/')) return 'Picture';
  if (type.startsWith('audio/')) return 'Audio';
  // Code is kept under no type of its own, and known by its name alone.
  if (type === 'application/octet-stream') {
    return languageOf(type, artifact.file?.name) ? 'Code' : TYPE_NAME.file;
  }
  return kindNames[type] ?? TYPE_NAME.file;
}

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
  svg: 'bg-merged/15 text-merged',
  mermaid: 'bg-good/15 text-good',
  file: 'bg-ink/8 text-muted',
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
  const Icon =
    artifact.type !== 'file' ? ICON[artifact.type] : artifact.file ? fileIcon(artifact.file) : File;

  return <Icon size={size} aria-hidden="true" className={`shrink-0 ${className}`} />;
}
