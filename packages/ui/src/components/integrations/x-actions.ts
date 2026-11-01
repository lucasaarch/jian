'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { notifyError } from '../../lib/workspace';
import { xOutcome } from '../../lib/x';
import { usePathname, useRouter, useSearchParams } from '../../platform/navigation';

export type XIntegration = Awaited<ReturnType<GatewayApi['xIntegration']>>;
export type XAccount = XIntegration['accounts'][number];

/**
 * X sends the owner back with the outcome in the query: it is said once, then dropped from the
 * address, and what it changed is read again. Read through the host's navigation, it reaches the panel whether the browser came back
 * to the web host or a desktop app opened at the same place.
 */
export function useXOutcome(): void {
  const client = useQueryClient();
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const outcome = xOutcome(params);
    if (!outcome) return;
    if (outcome.failed) toast.error(outcome.text, { duration: 12_000 });
    else toast.success(outcome.text);
    // Opened at this address the panel may be a new one, with nothing waiting to read it again.
    void client.invalidateQueries({ queryKey: keys.xIntegration });
    const rest = new URLSearchParams(params);
    rest.delete('x');
    rest.delete('reason');
    const query = rest.toString();
    router.replace(`${pathname}${query ? `?${query}` : ''}`);
  }, [client, params, pathname, router]);
}

/**
 * Connects an account, and lets one go. Connecting leaves for X's page: in this tab, or in the
 * system's browser when a desktop host keeps its window. Once the window is back in front, what
 * changed is read again, since no event of the gateway says so, and the wait ends.
 */
export function useXAccounts(api: GatewayApi) {
  const client = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string>();
  const away = useRef(false);

  useEffect(() => {
    const back = () => {
      if (!away.current) return;
      away.current = false;
      setConnecting(false);
      void client.invalidateQueries({ queryKey: keys.xIntegration });
    };
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [client]);

  const connect = async () => {
    setConnecting(true);
    try {
      const { url } = await api.startXConnection();
      away.current = true;
      window.location.assign(url);
    } catch (error) {
      notifyError(error, 'X sign-in could not start.');
      setConnecting(false);
    }
  };

  const disconnect = async (account: XAccount) => {
    setDisconnecting(account.id);
    try {
      await api.disconnectXAccount(account.id);
      await client.invalidateQueries({ queryKey: keys.xIntegration });
      toast.success(`@${account.handle} disconnected from Jian.`);
    } catch (error) {
      notifyError(error, 'The X account could not be disconnected.');
    } finally {
      setDisconnecting(undefined);
    }
  };

  return { connecting, connect, disconnecting, disconnect };
}
