import type { McpClientDocument } from '@jian/contracts';
import { readCappedJson } from '../core/read-capped.js';

/**
 * A client id metadata document (the MCP spec's Client ID Metadata Documents) is how an
 * authorization server with no dynamic registration, ElevenLabs' among them, learns who signs
 * in: the client id is an HTTPS address of this gateway, and the server fetches it to read the
 * client's name and where the sign-in may return. Each server name has its own, as each has its
 * own callback, so a document lists exactly the one address its sign-ins come back to.
 */

/** Why a sign-in that needs a document cannot start here, and what the owner can do about it. */
export const NO_CLIENT_DOCUMENT =
  "This server's sign-in reads who Jian is from an HTTPS address of this gateway that the internet " +
  "reaches. Set JIAN_PUBLIC_URL to the gateway's https:// address; the desktop app's own gateway " +
  'cannot sign in here.';

/**
 * The document's address for one server, or none where nothing outside could fetch it: the
 * spec requires HTTPS, and the desktop's gateway, or a server on plain http, has no such address.
 */
export function clientDocumentUrl(publicUrl: string, server: string): string | undefined {
  if (new URL(publicUrl).protocol !== 'https:') return undefined;
  return new URL(`/v1/mcp-servers/${server}/oauth/client`, publicUrl).toString();
}

/**
 * The document itself. Built only from this gateway's own address and a server name the route
 * already held to the name's rule: nothing an authorization server or a caller says reaches it.
 */
export function clientDocument(
  publicUrl: string,
  server: string,
  callbackUrl: string,
): McpClientDocument | undefined {
  const clientId = clientDocumentUrl(publicUrl, server);
  if (!clientId) return undefined;

  return {
    client_id: clientId,
    client_name: 'Jian',
    client_uri: 'https://usejian.app',
    logo_uri: 'https://usejian.app/apple-icon.png',
    redirect_uris: [callbackUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/** The most an authorization server's metadata may take, in bytes: real ones are a few KB. */
const MAX_METADATA_BYTES = 1024 * 1024;

/** The two things of an authorization server's metadata that decide how Jian becomes its client. */
type Registration = {
  registration_endpoint?: unknown;
  client_id_metadata_document_supported?: unknown;
};

/**
 * Where RFC 8414 and OpenID Connect keep an authorization server's metadata, in the order the
 * MCP SDK tries them, so this reads the same document the sign-in will.
 */
function metadataUrls(authorizationServer: URL): URL[] {
  const path = authorizationServer.pathname.replace(/\/$/, '');
  const at = (pathname: string) => new URL(pathname, authorizationServer.origin);

  return path
    ? [
        at(`/.well-known/oauth-authorization-server${path}`),
        at('/.well-known/oauth-authorization-server'),
        at(`/.well-known/openid-configuration${path}`),
        at(`${path}/.well-known/openid-configuration`),
      ]
    : [at('/.well-known/oauth-authorization-server'), at('/.well-known/openid-configuration')];
}

/**
 * Whether an authorization server takes a document and offers no registration: dynamic
 * registration stays the first choice where both exist, as every other app signs in that way.
 * Any failure to read the metadata answers no, and the SDK's own discovery then reports it.
 */
export async function wantsClientDocument(
  authorizationServer: string | URL,
  fetcher: typeof globalThis.fetch,
): Promise<boolean> {
  for (const url of metadataUrls(new URL(authorizationServer))) {
    try {
      const response = await fetcher(url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const metadata = (await readCappedJson(response, MAX_METADATA_BYTES)) as Registration;
      return (
        !metadata.registration_endpoint && metadata.client_id_metadata_document_supported === true
      );
    } catch {}
  }

  return false;
}
