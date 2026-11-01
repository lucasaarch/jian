/** A call the fake X received, with what it was asked. */
export type XCall = { method: string; path: string; body: unknown; auth: string | null };

type Handler = (call: XCall) => Response | Promise<Response> | undefined;

/**
 * X as an injected fetch: the token endpoint rotates on every use, as the real one does, and
 * anything a test does not script answers 404. Never the real API.
 */
export function fakeX(options: { handle?: string; id?: string; handler?: Handler } = {}) {
  const calls: XCall[] = [];
  let generation = 0;
  let live = 'synthetic-refresh-0';
  const state = { refuseRefresh: false };

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const raw = init?.body;
    const body =
      typeof raw === 'string'
        ? url.pathname === '/2/oauth2/token'
          ? Object.fromEntries(new URLSearchParams(raw))
          : JSON.parse(raw)
        : raw;
    const call: XCall = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body,
      auth: new Headers(init?.headers).get('authorization'),
    };

    calls.push(call);

    if (url.pathname === '/2/oauth2/token') {
      const grant = body as Record<string, string>;

      // A refresh token works once: presenting a used one is what kills a real connection.
      if (
        state.refuseRefresh ||
        (grant.grant_type === 'refresh_token' && grant.refresh_token !== live)
      ) {
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      }

      generation += 1;
      live = `synthetic-refresh-${generation}`;

      return Response.json({
        access_token: `synthetic-access-${generation}`,
        refresh_token: live,
        expires_in: 7200,
        scope: (grant.scopes ?? '').length ? grant.scopes : undefined,
      });
    }

    const answered = await options.handler?.(call);

    if (answered) return answered;

    if (url.pathname === '/2/users/me') {
      return Response.json({
        data: {
          id: options.id ?? '1001',
          name: 'Fictional Example',
          username: options.handle ?? 'fictional_one',
        },
      });
    }

    return Response.json({ title: 'Not Found', detail: 'no such thing' }, { status: 404 });
  }) as typeof fetch;

  return {
    fetcher,
    calls,
    state,
    /** The calls that were not to the token endpoint. */
    apiCalls: () => calls.filter(({ path }) => !path.startsWith('/2/oauth2/token')),
    refreshes: () =>
      calls.filter(
        ({ path, body }) =>
          path === '/2/oauth2/token' &&
          (body as Record<string, string>).grant_type === 'refresh_token',
      ),
  };
}
