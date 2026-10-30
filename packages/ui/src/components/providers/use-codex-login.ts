'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { GatewayApi, Mutation } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { handOff } from './codex-login';

type CodexLogin = Awaited<ReturnType<GatewayApi['codexLogin']>>;

/**
 * The ChatGPT sign-in: its state, read once and then every five seconds while it waits for the
 * owner, and the code to show them. A check that fails ends the wait as a failure instead of
 * polling on. The code shows on the owner's click only, so a sign-in found pending on a reload
 * stays a line, not a dialog. The wait ending in a connection is a provider added: it is said
 * and the providers are read again.
 */
export function useCodexLogin(api: GatewayApi, mutate: Mutation) {
  const client = useQueryClient();
  const { data: login } = useQuery({
    queryKey: keys.codexLogin,
    queryFn: () =>
      api
        .codexLogin()
        .catch((): CodexLogin => ({ status: 'failed', error: 'The login could not be checked.' })),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 5000 : false),
  });
  const [codeShown, setCodeShown] = useState<{ copied: boolean }>();
  const waiting = useRef(false);

  useEffect(() => {
    if (login?.status === 'pending') waiting.current = true;
    else if (waiting.current) {
      waiting.current = false;
      setCodeShown(undefined);
      if (login?.status === 'connected') void mutate(async () => {}, 'ChatGPT connected.');
    }
  }, [login?.status, mutate]);

  /** Starts a sign-in; it throws when the gateway cannot start one. */
  const start = async () => {
    const next = await api.startCodexLogin();

    client.setQueryData(keys.codexLogin, next);
    if (next.status === 'pending') setCodeShown({ copied: await handOff(next) });
  };

  return {
    login,
    codeShown,
    start,
    showCode: () => setCodeShown({ copied: false }),
    hideCode: () => setCodeShown(undefined),
  };
}
