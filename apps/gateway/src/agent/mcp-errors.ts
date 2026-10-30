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

/**
 * Failures where a mutating call was written and never answered with a definitive application
 * result. Only these interrupt the run as an uncertain external effect.
 *
 * Clear API refusals (HTTP 4xx validation, JSON-RPC application errors, `isError` results) are
 * not listed here — they surface as normal tool errors so the agent can continue.
 */
const UNKNOWN_OUTCOME = [
  /Connection closed/i,
  /fetch failed/i,
  /socket hang up/i,
  /other side closed/i,
  /ECONNRESET/i,
  /EPIPE/i,
  /ETIMEDOUT/i,
  /UND_ERR_/i,
  /network error/i,
  /Request timed out/i,
  /The operation was aborted/i,
  /This operation was aborted/i,
  /aborted without reason/i,
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

function matches(error: unknown, patterns: RegExp[]): boolean {
  return causes(error).some((cause) => patterns.some((pattern) => pattern.test(cause.message)));
}

/** True when the MCP client was already disconnected before any request was sent. */
export function mcpClientDisconnected(error: unknown): boolean {
  return matches(error, DISCONNECTED);
}

/**
 * True when a mutating MCP call may have applied with no definitive answer — drop after send,
 * timeout, or transport collapse mid-flight. Pre-send disconnects and clear application errors
 * return false so the runtime can reconnect or continue with a tool error.
 */
export function mcpOutcomeUncertain(error: unknown): boolean {
  if (mcpClientDisconnected(error)) return false;
  return matches(error, UNKNOWN_OUTCOME);
}
