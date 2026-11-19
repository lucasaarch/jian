import type { SessionArtifactType } from '@jian/contracts';

/**
 * About how long each type of Artifact runs, in characters of source, which is all there is to go
 * by: nothing says how long one will be until it is written. A page and a deck carry their styles,
 * a diagram is a few lines.
 */
const USUAL: Record<SessionArtifactType, number> = {
  html: 12_000,
  react: 8_000,
  deck: 24_000,
  markdown: 4_000,
  sheet: 3_000,
  mermaid: 1_500,
};

/**
 * How far along an Artifact seems, from 0 towards 1, which it never reaches until the call ends:
 * it slows as it goes, so one longer than usual still moves and never stands at its end.
 */
export function written(type: SessionArtifactType | undefined, length: number, done: boolean) {
  if (done) return 1;
  return 1 - Math.exp(-length / USUAL[type ?? 'html']);
}

/** The words beside the picture of one being made, by how far along it seems. */
export function buildingWords(progress: number): string {
  if (progress < 0.2) return 'Generating…';
  if (progress < 0.75) return 'Building…';
  return 'Almost there…';
}
