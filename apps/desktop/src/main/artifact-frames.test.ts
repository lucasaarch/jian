import { describe, expect, it } from 'vitest';
import { leavesArtifactFrame } from './artifact-frames';

const shell = 'http://127.0.0.1:4310/v1/artifact-frames/html';

describe('leavesArtifactFrame', () => {
  it('refuses an Artifact that takes itself, or its frame, to any address', () => {
    for (const url of ['https://evil.test/?d=secret', 'data:text/html,x', 'blob:null/1']) {
      expect(leavesArtifactFrame({ isMainFrame: false, url, frameUrl: shell })).toBe(true);
      expect(
        leavesArtifactFrame({
          isMainFrame: false,
          url,
          frameUrl: 'about:srcdoc',
          parentUrl: shell,
        }),
      ).toBe(true);
    }
  });

  it('leaves the panel and its other frames alone', () => {
    const url = 'https://evil.test/';
    expect(leavesArtifactFrame({ isMainFrame: true, url, frameUrl: shell })).toBe(false);
    expect(
      leavesArtifactFrame({ isMainFrame: false, url, frameUrl: 'app://jian/index.html' }),
    ).toBe(false);
    expect(leavesArtifactFrame({ isMainFrame: false, url: 'about:srcdoc', frameUrl: shell })).toBe(
      false,
    );
  });
});
