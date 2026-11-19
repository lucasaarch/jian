import { describe, expect, it } from 'vitest';
import { ArtifactDraft } from '../src/agent/artifact-draft.js';

const ID = '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

/** The input written in pieces, each read at once, as the end of an input is. */
async function follow(toolName: string, input: object, pieces = 8) {
  const draft = new ArtifactDraft(() => 0);
  const json = JSON.stringify(input);
  const size = Math.ceil(json.length / pieces);
  const told = [];

  draft.start('call', toolName);
  for (let at = 0; at < json.length; at += size) {
    told.push(await draft.push('call', json.slice(at, at + size), true));
  }
  return told.filter((said) => said !== undefined);
}

describe('the draft of an edit by replacements', () => {
  it('names the Artifact once its id is whole, with nothing of the edits, and only once', async () => {
    const told = await follow('edit_artifact', {
      artifactId: ID,
      edits: [
        { find: 'Old title', replace: 'New title' },
        { find: '<p>a</p>', replace: '' },
      ],
    });

    expect(told).toEqual([{ toolCallId: 'call', artifactId: ID, content: '' }]);
  });

  it('names nothing before the id is whole', async () => {
    const draft = new ArtifactDraft(() => 0);
    draft.start('call', 'edit_artifact');

    expect(await draft.push('call', `{"artifactId":"${ID.slice(0, 20)}`, true)).toBeUndefined();
  });

  it('follows no other tool', async () => {
    expect(await follow('read_artifact_source', { artifactId: ID })).toEqual([]);
    expect(await follow('constructor', { artifactId: ID })).toEqual([]);
  });
});
