import { reconnect, refusal, unanswered, XFailure } from './failures.js';
import { X_API } from './oauth.js';
import type { XTokens } from './tokens.js';

export type XActor = { id: string; userId: string; handle: string; scopes: string[] };

export type XRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as multipart, for media. */
  form?: FormData;
  scopes: readonly string[];
  /** Changes something on X: an answer that never came leaves that unknown. */
  acts: boolean;
  signal?: AbortSignal | undefined;
};

/** A request's limit, in milliseconds; an upload's segment is the largest thing sent. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Every call to X goes through here, to a fixed host and through the outbound guard the gateway
 * hands it. A token never leaves this file except in the Authorization header.
 */
export class XClient {
  constructor(
    private readonly tokens: Pick<XTokens, 'current' | 'renew'>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private send(request: XRequest, accessToken: string, raw: boolean) {
    const url = new URL(request.path, X_API);

    for (const [name, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(name, value);
    }

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const json = request.body !== undefined;

    return this.fetcher(url.toString(), {
      method: request.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(json ? { 'content-type': 'application/json' } : {}),
        ...(raw ? {} : { accept: 'application/json' }),
      },
      ...(json ? { body: JSON.stringify(request.body) } : {}),
      ...(request.form ? { body: request.form } : {}),
      signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
    });
  }

  private async exchange(account: XActor, request: XRequest, raw: boolean): Promise<Response> {
    // Asked here rather than left for X to refuse: it costs nothing and says what to do about it.
    const missing = request.scopes.filter((scope) => !account.scopes.includes(scope));

    if (missing.length > 0) {
      throw new XFailure(
        409,
        `@${account.handle} was connected with fewer permissions than this needs (${missing.join(', ')}). Nothing was done. The owner has to connect it again in Settings > Apps > X.`,
      );
    }

    const tokens = await this.tokens.current(account);

    try {
      let response = await this.send(request, tokens.accessToken, raw);

      // X refused the token before doing anything, so asking again is safe for a write too.
      if (response.status === 401) {
        const renewed = await this.tokens.renew(account, tokens.accessToken);

        response = await this.send(request, renewed.accessToken, raw);

        if (response.status === 401) throw new XFailure(409, reconnect(account.handle));
      }

      return response;
    } catch (error) {
      if (error instanceof XFailure) throw error;
      if (request.signal?.aborted) throw error;
      throw unanswered(request.acts);
    }
  }

  /** The body X answered with, as X wrote it. */
  async call(account: XActor, request: XRequest): Promise<unknown> {
    const response = await this.exchange(account, request, false);
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw refusal(
        response.status,
        body as object,
        account.handle,
        response.headers.get('x-rate-limit-reset'),
      );
    }

    return body;
  }

  /** The bytes X answered with, for the rare call whose answer is a file. */
  async download(account: XActor, request: XRequest) {
    const response = await this.exchange(account, request, true);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));

      throw refusal(response.status, body as object, account.handle);
    }

    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}
