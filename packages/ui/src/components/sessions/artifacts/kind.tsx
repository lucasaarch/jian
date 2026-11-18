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

/** The icon that says what kind an Artifact is, beside its name in the list. */
export function KindIcon({ artifact }: { artifact: Listed }) {
  const Icon =
    artifact.type !== 'file' ? ICON[artifact.type] : artifact.file ? fileIcon(artifact.file) : File;

  return <Icon size={16} aria-hidden="true" className="shrink-0 text-muted" />;
}
