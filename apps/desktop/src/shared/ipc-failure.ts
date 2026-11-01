/**
 * What the main process said, without the wrapping Electron adds on its way to the window: it is
 * shown to the owner as it is, and a channel's name means nothing to them.
 */
export function plainFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''));
}
