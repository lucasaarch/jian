'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { connectChannel } from '../../components/channels/connect';
import { Action, SettingsGroup, SettingsRow, StatusPill } from '../../kit';
import type { Channel, ChannelType, NewChannel } from '../../lib/api';
import { panelApi } from '../../lib/query/client';
import { keys } from '../../lib/query/keys';
import { queries } from '../../lib/query/profile';
import { ChannelAddDialog } from '../customize/channel-add-dialog';
import { ChannelPairing } from '../customize/channel-pairing';

/** A channel may exist even when pairing fails; read it again before offering another create. */
export function WelcomeChannels({ profileId, finish }: { profileId: string; finish: () => void }) {
  const client = useQueryClient();
  const api = panelApi();
  const channels = useQuery(queries.channels(profileId));
  const [kind, setKind] = useState<ChannelType>('whatsapp');
  const [adding, setAdding] = useState(false);
  const [round, setRound] = useState(0);
  const [pairing, setPairing] = useState<Channel>();
  const [pairOpen, setPairOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pair = (channel: Channel) => {
    setPairing(channel);
    setPairOpen(true);
  };
  const connect = async (request: NewChannel) => {
    setBusy(true);
    setError('');
    try {
      const channel = await connectChannel(api, profileId, request, {
        pairing: pair,
        secret: () => {},
      });
      if (channel.type === 'telegram' && channel.webhookRegistered === false) {
        setError(
          channel.webhookError ||
            'Telegram could not register its webhook. Check the gateway’s public HTTPS address in Settings.',
        );
      }
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The channel could not be connected.');
      return false;
    } finally {
      await client.invalidateQueries({ queryKey: keys.channels(profileId) });
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto grid w-full max-w-xl gap-6">
      <SettingsGroup>
        {(['whatsapp', 'telegram'] as const).map((type) => {
          const channel = channels.data?.find((item) => item.type === type && !item.revokedAt);
          return (
            <SettingsRow
              key={type}
              title={type === 'whatsapp' ? 'WhatsApp' : 'Telegram'}
              description={
                type === 'whatsapp'
                  ? 'Link your phone with a QR code.'
                  : 'Connect a bot from BotFather.'
              }
            >
              {channel && type === 'telegram' ? (
                <StatusPill>Added</StatusPill>
              ) : (
                <Action
                  tone="outline"
                  disabled={busy || !channels.data}
                  onClick={() => {
                    if (channel) pair(channel);
                    else {
                      setKind(type);
                      setRound((value) => value + 1);
                      setAdding(true);
                    }
                  }}
                >
                  {channel ? 'Pair device' : 'Connect'}
                </Action>
              )}
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      {(error || channels.isError) && (
        <p role="alert" className="text-sm text-bad">
          {error || 'Channels could not be read.'}
        </p>
      )}
      {channels.isError && <Action onClick={() => void channels.refetch()}>Try again</Action>}
      <p className="text-center text-sm text-muted">
        New contacts need your approval before your agent replies.
      </p>
      <div className="flex justify-center gap-3">
        <Action tone="quiet" onClick={finish} disabled={busy}>
          Skip for now
        </Action>
        <Action tone="primary" onClick={finish} disabled={busy}>
          Open chat
        </Action>
      </div>
      <ChannelAddDialog
        open={adding}
        onOpenChange={setAdding}
        round={round}
        available={[kind]}
        busy={busy}
        connect={connect}
      />
      <ChannelPairing
        open={pairOpen}
        onOpenChange={setPairOpen}
        channel={pairing}
        profileId={profileId}
        api={api}
      />
    </div>
  );
}
