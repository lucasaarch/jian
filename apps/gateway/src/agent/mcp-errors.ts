/**
 * Transport failures that prove no `tools/call` left this process — the client was already dead
 * (or never connected) before send. Safe to tear down, reconnect, and retry.
 *
 * Distinct from a connection that drops after a call was written: there a mutating tool's
 * outcome is unknowable and the run must stop for reconciliation.
 */
const DISCONNECTED = [
  /Attempted to send a request from a closed client/i,
  /MCP SSE Transport Error: Not connected/i,
  /The MCP command is not running/i,
];

/** Walk an error and its causes the same way the runtime does for provider refusals. */
function causes(error: unknown): Error[] {
  const chain: Error[] = [];
  let current = error;

  while (current instanceof Error && !chain.includes(current)) {
    chain.push(current);
    current = current.cause;
  }

  return chain;
}

/** True when the MCP client was already disconnected before any request was sent. */
export function mcpClientDisconnected(error: unknown): boolean {
  return causes(error).some((cause) => DISCONNECTED.some((pattern) => pattern.test(cause.message)));
}

/** @deprecated Prefer mcpClientDisconnected — same meaning. */
export const mcpRequestNeverSent = mcpClientDisconnected;
