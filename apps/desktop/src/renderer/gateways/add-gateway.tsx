import { Action, Overlay, TextField } from '@jian/ui';
import { ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { GatewaySummary } from '../../shared/bridge';
import { desktop } from '../desktop';

/**
 * Connecting a gateway that runs on a server, beside the app's own: its address and host token,
 * checked against the gateway before the app keeps them.
 */
export function AddGateway({
  open,
  onOpenChange,
  added,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  added: (gateway: GatewaySummary) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    const result = await desktop().addGateway({
      url: String(form.get('url') ?? ''),
      token: String(form.get('token') ?? ''),
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    added(result.gateway);
    onOpenChange(false);
  };

  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Connect a gateway" size="form">
      <form onSubmit={submit} className="grid w-full gap-5 p-7">
        <header className="grid gap-1">
          <h2 className="text-xl font-semibold tracking-tight">Connect a gateway</h2>
          <p className="text-sm text-muted">
            One you run on a server: its address and host token, as you sign in on the web.
          </p>
        </header>
        <TextField
          label="Address"
          name="url"
          type="url"
          placeholder="https://jian.example.com"
          required
          autoComplete="off"
          spellCheck={false}
        />
        <TextField
          label="Host token"
          name="token"
          type="password"
          placeholder="JIAN_API_TOKEN from the server"
          required
          autoComplete="off"
          spellCheck={false}
        />
        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
        <p className="flex items-center gap-2 text-xs text-muted">
          <ShieldCheck size={14} />
          The token stays in this computer’s keychain and never reaches the window.
        </p>
        <div className="flex justify-end gap-2">
          <Action tone="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Action>
          <Action tone="primary" type="submit" busy={busy}>
            Connect
          </Action>
        </div>
      </form>
    </Overlay>
  );
}
