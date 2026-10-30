'use client';

import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { toast } from 'sonner';
import { states } from '../../components/channels/kinds';
import { usePairing } from '../../components/channels/use-pairing';
import { Action, Overlay, StatusPill } from '../../kit';
import type { Channel, GatewayApi } from '../../lib/api';

/**
 * Linking a phone's WhatsApp to the agent: the QR code to scan while the device waits for one,
 * then the account it linked. The device's state is read only while this is open.
 */
export function ChannelPairing({
  open,
  onOpenChange,
  channel,
  profileId,
  api,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kept while the dialog fades out. */
  channel: Channel | undefined;
  profileId: string;
  api: GatewayApi;
}) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Connect WhatsApp" size="form">
      {channel && (
        <PairingStage
          channel={channel}
          profileId={profileId}
          api={api}
          close={() => onOpenChange(false)}
        />
      )}
    </Overlay>
  );
}

function PairingStage({
  channel,
  profileId,
  api,
  close,
}: {
  channel: Channel;
  profileId: string;
  api: GatewayApi;
  close: () => void;
}) {
  const { connection, qr, unreadable, start } = usePairing(profileId, channel, api);
  const [starting, setStarting] = useState(false);
  const linked = connection?.status === 'connected';
  const failure = unreadable || connection?.error;

  const restart = async () => {
    setStarting(true);
    try {
      await start();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The connection failed.');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="grid w-full gap-5 p-7">
      <header className="grid gap-1.5 pr-6">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          Connect WhatsApp
          {linked && <StatusPill tone="good">Connected</StatusPill>}
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          On your phone, open WhatsApp → Linked devices → Link a device.
        </p>
      </header>
      <div className="grid min-h-64 place-items-center gap-3 rounded-xl border border-glass-edge bg-glass-hover p-5 text-center">
        {linked ? (
          <div className="grid gap-1">
            <span className="text-sm font-medium text-ink">{connection.accountId}</span>
            <span className="text-xs text-muted">
              {connection.sessionSavedAt
                ? 'The encrypted session is saved on the gateway.'
                : 'Saving the first copy of the session. This takes about a minute.'}
            </span>
          </div>
        ) : qr ? (
          <>
            {/* The code keeps its own white ground, as a phone's camera needs in either theme. */}
            <QRCodeSVG
              value={qr.qr}
              size={208}
              level="M"
              marginSize={2}
              title="QR code to link WhatsApp"
              className="rounded-lg"
            />
            <span className="text-xs text-muted">The code refreshes on its own.</span>
          </>
        ) : (
          <div className="grid gap-1">
            <span className="text-sm font-medium text-ink">
              {connection ? states[connection.status] : 'Reading the connection'}
            </span>
            <span className="text-xs text-muted">
              {connection?.status === 'connecting' || connection?.status === 'qr'
                ? 'Waiting for the gateway to prepare a new QR code.'
                : 'Start the connection to get a QR code.'}
            </span>
          </div>
        )}
      </div>
      {failure && (
        <p role="alert" className="text-[13px] text-bad">
          {failure}
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted">
        Keep the QR code private. Anyone who writes arrives as a request: nothing is answered before
        you approve it.
      </p>
      <div className="flex items-center gap-2">
        <span className="flex-1" />
        <Action tone="quiet" onClick={close}>
          Close
        </Action>
        {!linked && (
          <Action tone="primary" busy={starting} onClick={() => void restart()}>
            {connection?.status === 'connecting' || connection?.status === 'qr'
              ? 'Reconnect'
              : 'Generate QR code'}
          </Action>
        )}
      </div>
    </div>
  );
}
