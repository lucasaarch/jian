'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Channel, GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';

/**
 * A WhatsApp device's pairing while it is shown: its state read every five seconds, and a QR
 * code asked for only while the device waits for one, replaced as it rotates. `qr` is the code
 * while it is still valid; `start` asks the gateway for a new pairing and throws when it refuses.
 */
export function usePairing(profileId: string, channel: Channel, api: GatewayApi) {
  const client = useQueryClient();
  const [now, setNow] = useState(Date.now());
  const connectionQuery = useQuery({
    queryKey: keys.channelConnection(profileId, channel.id),
    queryFn: () => api.connection(profileId, channel.id),
    refetchInterval: 5000,
    retry: false,
  });
  const connection = connectionQuery.data;
  const waiting = connection?.status === 'qr' && !connectionQuery.isError;
  const qrQuery = useQuery({
    queryKey: keys.channelQr(profileId, channel.id),
    queryFn: () => api.qr(profileId, channel.id),
    enabled: waiting,
    refetchInterval: 5000,
    retry: false,
  });
  const qr = waiting ? qrQuery.data : undefined;
  const unreadable = connectionQuery.error ?? qrQuery.error;

  // The code's countdown, in seconds.
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(clock);
  }, []);

  return {
    connection,
    qr: qr && Date.parse(qr.expiresAt) > now ? qr : undefined,
    /** Why the device's state could not be read, if it could not. */
    unreadable: unreadable
      ? unreadable instanceof Error
        ? unreadable.message
        : 'The connection could not be read.'
      : '',
    start: async () => {
      client.setQueryData(
        keys.channelConnection(profileId, channel.id),
        await api.connect(profileId, channel.id),
      );
    },
  };
}
