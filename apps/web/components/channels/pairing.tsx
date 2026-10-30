'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, QrCode, Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { keys } from '@/lib/query/keys';
import type { Channel, GatewayApi } from '../../lib/api';
import { Button, Modal } from '../ui';
import { states } from './kinds';

export function Pairing({
  profileId,
  channel,
  api,
  close,
}: {
  profileId: string;
  channel: Channel;
  api: GatewayApi;
  close: () => void;
}) {
  const client = useQueryClient();
  const [now, setNow] = useState(Date.now());
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  // The device's state, read every five seconds while the dialog is open; a QR code is only
  // asked for while the device is waiting for one, and replaced as it rotates.
  const connectionQuery = useQuery({
    queryKey: keys.channelConnection(profileId, channel.id),
    queryFn: () => api.connection(profileId, channel.id),
    refetchInterval: 5000,
    retry: false,
  });
  const connection = connectionQuery.data;
  const qrQuery = useQuery({
    queryKey: keys.channelQr(profileId, channel.id),
    queryFn: () => api.qr(profileId, channel.id),
    enabled: connection?.status === 'qr' && !connectionQuery.isError,
    refetchInterval: 5000,
    retry: false,
  });
  const qr = connection?.status === 'qr' && !connectionQuery.isError ? qrQuery.data : undefined;
  const unreadable = connectionQuery.error ?? qrQuery.error;
  const error =
    failure ||
    (unreadable
      ? unreadable instanceof Error
        ? unreadable.message
        : 'The connection could not be read.'
      : '');

  // The code's countdown.
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(clock);
  }, []);

  const validQr = qr && Date.parse(qr.expiresAt) > now;

  return (
    <Modal
      title="Connect WhatsApp"
      description="On your phone, open WhatsApp → Linked devices → Link a device."
      close={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
          {connection?.status !== 'connected' && (
            <Button
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setFailure('');

                try {
                  client.setQueryData(
                    keys.channelConnection(profileId, channel.id),
                    await api.connect(profileId, channel.id),
                  );
                } catch (error) {
                  setFailure(error instanceof Error ? error.message : 'The connection failed.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <QrCode size={16} />
              {connection?.status === 'connecting' || connection?.status === 'qr'
                ? 'Reconnect'
                : 'Generate QR code'}
            </Button>
          )}
        </>
      }
    >
      <div className="pairing-stage">
        {connection?.status === 'connected' ? (
          <>
            <div className="success-orbit">
              <Check size={32} />
            </div>
            <h3>WhatsApp connected</h3>
            <p>{connection.accountId}</p>
            <small>
              {connection.sessionSavedAt
                ? 'The encrypted session is saved on the gateway.'
                : 'Saving the first copy of the session. This takes about a minute.'}
            </small>
          </>
        ) : validQr ? (
          <>
            <div className="qr-frame">
              <QRCodeSVG
                value={qr.qr}
                size={240}
                level="M"
                marginSize={2}
                title="QR code to link WhatsApp"
              />
            </div>
            <small>The code refreshes on its own.</small>
          </>
        ) : (
          <>
            <Smartphone size={40} strokeWidth={1.5} />
            <h3>{connection ? states[connection.status] : 'Reading the connection'}</h3>
            <p>
              {connection?.status === 'connecting' || connection?.status === 'qr'
                ? 'Waiting for the gateway to prepare a new QR code.'
                : 'Start the connection to get a QR code.'}
            </p>
          </>
        )}
      </div>
      {(error || connection?.error) && (
        <p className="form-error" role="alert">
          {error || connection?.error}
        </p>
      )}
      <p className="note">
        This pairs a device to your own WhatsApp, so keep the QR code private. Anyone who writes
        arrives as a contact request: nothing is answered before you approve it.
      </p>
    </Modal>
  );
}
