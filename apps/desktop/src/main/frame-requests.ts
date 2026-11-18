/** The one gateway document a frame may load: it holds no Artifact and needs no credential. */
const ARTIFACT_FRAME = /^\/v1\/artifact-frames\/[a-z]+$/;

/** Destinations of a request that loads a document or embeds one, which the panel never makes of a gateway. */
const EMBEDDING = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

/**
 * What the main process does with a request for a gateway path.
 *
 * An Artifact runs in a sandboxed frame and can send that frame, or frames it creates, to
 * `jian://app/gateway/...`. The panel's own calls are fetches from its own origin; a frame that
 * navigates arrives as a document load, or from a site that is not the panel's (an opaque origin
 * is never the same site). Neither may be signed with the owner's token, even though the page
 * cannot read the answer. Missing headers are taken as the panel's own: Chromium sets them on
 * every request to this scheme, and a request the window did not make never reaches the handler.
 */
export function frameRequest(path: string, headers: Headers): 'sign' | 'unsigned' | 'refuse' {
  if (ARTIFACT_FRAME.test(path)) return 'unsigned';
  const destination = headers.get('sec-fetch-dest');
  if (destination && EMBEDDING.has(destination)) return 'refuse';
  const site = headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return 'refuse';
  return 'sign';
}
