const ARTIFACT_FRAMES = '/v1/artifact-frames/';

/**
 * Whether a frame navigation is an Artifact trying to leave. The gateway's policy already refuses
 * it (`frame-src 'none'` on the shell); this is the same rule held by the host, so a page that
 * slipped past a browser quirk still goes nowhere. The shell's own `srcdoc` load is the one
 * navigation an Artifact's frame is allowed.
 *
 * `frameUrl` and `parentUrl` are where the navigating frame and its parent are now.
 */
export function leavesArtifactFrame(input: {
  isMainFrame: boolean;
  url: string;
  frameUrl: string;
  parentUrl?: string;
}): boolean {
  if (input.isMainFrame) return false;
  const inArtifact = [input.frameUrl, input.parentUrl].some((url) =>
    url?.includes(ARTIFACT_FRAMES),
  );
  return inArtifact && input.url !== 'about:srcdoc';
}
