import { createMCPClient, type MCPClient, type MCPClientConfig } from '@ai-sdk/mcp';

/**
 * JSON-RPC codes the MCP 2026-07-28 era uses for version / era mismatches. `@ai-sdk/mcp`
 * treats these as proof the peer is modern and refuses to fall back to `initialize` — which
 * breaks dual-era hosts that disable modern serving and ask for a legacy handshake instead
 * (Atlassian `https://mcp.atlassian.com/v2/mcp`).
 */
const MODERN_PROTOCOL_ERROR_CODES = new Set([-32020, -32021, -32022]);

/** Wording Atlassian (and similar dual-era gates) return when modern serving is off. */
const LEGACY_FALLBACK_MESSAGE =
  /modern mcp serving is disabled|negotiate a supported legacy protocol/i;

const MODERN_PROTOCOL_VERSION = /^2026-/;

function errorCode(error: unknown): number | undefined {
  return error != null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'number'
    ? error.code
    : undefined;
}

function errorData(error: unknown): unknown {
  return error != null && typeof error === 'object' && 'data' in error ? error.data : undefined;
}

/** Versions the server named in an UnsupportedProtocolVersion-style payload, if any. */
export function supportedProtocolVersions(error: unknown): string[] | undefined {
  const data = errorData(error);

  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }

  const supported = (data as { supported?: unknown }).supported;

  if (!Array.isArray(supported) || !supported.every((item) => typeof item === 'string')) {
    return undefined;
  }

  return supported;
}

/**
 * True when a failed modern `server/discover` probe should be retried as a legacy
 * `initialize` handshake — not when the peer is modern-only.
 */
export function shouldFallbackToLegacyInitialize(error: unknown): boolean {
  if (error instanceof Error && LEGACY_FALLBACK_MESSAGE.test(error.message)) {
    return true;
  }

  const code = errorCode(error);

  if (code == null || !MODERN_PROTOCOL_ERROR_CODES.has(code)) {
    return false;
  }

  const supported = supportedProtocolVersions(error);

  if (!supported || supported.length === 0) {
    return false;
  }

  const offersModern = supported.some((version) => MODERN_PROTOCOL_VERSION.test(version));
  const offersLegacy = supported.some((version) => !MODERN_PROTOCOL_VERSION.test(version));

  // Dual-era host listing only legacy revisions (or modern disabled with legacy named).
  return offersLegacy && !offersModern;
}

/**
 * Opens an MCP client with discovery first, then a legacy handshake when the peer refuses
 * modern serving. Modern-only and plain legacy servers keep working unchanged.
 */
export async function createNegotiatedMcpClient(config: MCPClientConfig): Promise<MCPClient> {
  if (config.protocolVersionDiscovery === false) {
    return createMCPClient(config);
  }

  try {
    return await createMCPClient({ ...config, protocolVersionDiscovery: true });
  } catch (error) {
    if (!shouldFallbackToLegacyInitialize(error)) {
      throw error;
    }

    return createMCPClient({ ...config, protocolVersionDiscovery: false });
  }
}
