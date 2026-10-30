import { Action, Overlay, SettingsGroup, SettingsLayout, TextField } from '@jian/ui';
import { KeyRound, Laptop, Link2, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { GatewaySummary } from '../../shared/bridge';
import { desktop } from '../desktop';
import { forget } from './navigation';

type Page = 'connection' | 'remove';

/** One gateway's connection, opened from its gear in the status bar. */
export function GatewaySettings({
  gateway,
  onOpenChange,
}: {
  /** The gateway to show; undefined closes the overlay. */
  gateway: GatewaySummary | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const [page, setPage] = useState<Page>('connection');
  const pages = [
    { id: 'connection', label: 'Connection', icon: <Link2 size={16} />, group: 'Gateway' },
    ...(gateway?.local
      ? []
      : [{ id: 'remove', label: 'Remove', icon: <Trash2 size={16} />, group: 'Gateway' }]),
  ];

  return (
    <Overlay
      open={Boolean(gateway)}
      onOpenChange={onOpenChange}
      title={`${gateway?.name ?? 'Gateway'} settings`}
    >
      {gateway && (
        <SettingsLayout
          heading={gateway.name}
          pages={pages}
          current={gateway.local ? 'connection' : page}
          onSelect={(id) => setPage(id as Page)}
        >
          {page === 'remove' && !gateway.local ? (
            <Remove gateway={gateway} done={() => onOpenChange(false)} />
          ) : gateway.local ? (
            <Local gateway={gateway} />
          ) : (
            <Connection key={gateway.id} gateway={gateway} />
          )}
        </SettingsLayout>
      )}
    </Overlay>
  );
}

function Local({ gateway }: { gateway: GatewaySummary }) {
  return (
    <SettingsGroup
      title="On this computer"
      description="The app runs this gateway itself, and keeps its data in its own folder."
    >
      <p className="flex items-center gap-2 text-sm text-muted">
        <Laptop size={15} />
        {gateway.url ? `Listening on ${gateway.url}` : 'Starting…'}
        {gateway.version ? ` · ${gateway.version}` : ''}
      </p>
    </SettingsGroup>
  );
}

function Connection({ gateway }: { gateway: GatewaySummary }) {
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState<'name' | 'token'>();

  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy('name');
    await desktop().renameGateway(
      gateway.id,
      String(new FormData(event.currentTarget).get('name') ?? ''),
    );
    setBusy(undefined);
    setSaid({ ok: true, text: 'Renamed.' });
  };

  const replace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy('token');
    const result = await desktop().replaceToken(
      gateway.id,
      String(new FormData(form).get('token') ?? ''),
    );
    setBusy(undefined);
    setSaid(result.ok ? { ok: true, text: 'Token saved.' } : { ok: false, text: result.error });
    if (result.ok) form.reset();
  };

  return (
    <>
      <form onSubmit={rename}>
        <SettingsGroup title="Name" description={gateway.url}>
          <TextField
            label="Name"
            name="name"
            defaultValue={gateway.name}
            required
            maxLength={60}
            autoComplete="off"
          />
          <div className="flex justify-end">
            <Action tone="glass" type="submit" busy={busy === 'name'}>
              Rename
            </Action>
          </div>
        </SettingsGroup>
      </form>
      <form onSubmit={replace}>
        <SettingsGroup
          title="Host token"
          description="When it was rotated on the server: the app checks the new one before it keeps it."
        >
          <TextField
            label="New host token"
            name="token"
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
          />
          <div className="flex justify-end">
            <Action tone="glass" type="submit" busy={busy === 'token'}>
              <KeyRound size={15} />
              Replace token
            </Action>
          </div>
        </SettingsGroup>
      </form>
      {said && (
        <p role="status" className={`text-sm ${said.ok ? 'text-muted' : 'text-bad'}`}>
          {said.text}
        </p>
      )}
    </>
  );
}

function Remove({ gateway, done }: { gateway: GatewaySummary; done: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <SettingsGroup
      title={`Remove ${gateway.name}`}
      description="The app forgets it and its token on this computer. The gateway and everything on it stay on the server."
    >
      <div>
        <Action
          tone="danger"
          busy={busy}
          className="border border-bad/40"
          onClick={async () => {
            setBusy(true);
            forget(gateway.id);
            await desktop().removeGateway(gateway.id);
            done();
          }}
        >
          <Trash2 size={15} />
          Remove from the app
        </Action>
      </div>
    </SettingsGroup>
  );
}
