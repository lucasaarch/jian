import type { ArtifactFrameError } from '@jian/contracts';
import type { SessionArtifact } from '../../../../lib/api';
import { TYPE_NAME } from '../source';

/** The error as one block of text: what it says, which part it broke in, where it was thrown. */
export function errorText(error: ArtifactFrameError): string {
  return [
    error.message,
    error.componentStack && `In\n${error.componentStack}`,
    error.stack && `Stack\n${error.stack}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A fence longer than any run of backticks inside, so nothing in the error can close it. */
const fenced = (text: string) => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
};

/**
 * What Fix sends the agent, as the owner's message in the conversation the Artifact was made in:
 * which Artifact and version failed, and the error in full. The error is the Artifact's own word
 * about itself, so it goes fenced, said to be a report and nothing to follow.
 */
export function fixRequest(
  artifact: Pick<SessionArtifact, 'id' | 'title' | 'type'>,
  version: number,
  error: ArtifactFrameError,
): string {
  return [
    `The ${TYPE_NAME[artifact.type].toLowerCase()} Artifact "${artifact.title}" (${artifact.id}, version ${version}) fails when it runs. This is the error its frame reported, as it reported it:`,
    fenced(errorText(error)),
    'Fix the Artifact, changing only what this error needs (edit_artifact, or update_artifact for a larger change), and tell me in a sentence what was wrong.',
  ].join('\n\n');
}
