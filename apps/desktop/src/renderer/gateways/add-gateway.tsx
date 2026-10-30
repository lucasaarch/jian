import { Button, Field, Mark } from '@jian/ui';
import { ArrowRight, CircleHelp, Server, ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { GatewaySummary } from '../../shared/bridge';
import { desktop } from '../desktop';

/**
 * Connecting a gateway that runs on a server, beside the app's own: its address and host token,
 * checked against the gateway before the app keeps them.
 */
export function AddGateway({
  added,
  cancel,
}: {
  added: (gateway: GatewaySummary) => void;
  cancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    const result = await desktop().addGateway({
      name: String(form.get('name') ?? ''),
      url: String(form.get('url') ?? ''),
      token: String(form.get('token') ?? ''),
    });
    setBusy(false);
    if (result.ok) added(result.gateway);
    else setError(result.error);
  };

  return (
    <main className="login-layout min-h-(--app-height)">
      <section className="login-story">
        <span className="brand">
          <Mark />
          <span>Jian</span>
        </span>
        <div className="login-copy">
          <div className="login-emblem" aria-hidden="true">
            <Mark />
          </div>
          <h1>
            Every gateway.
            <br />
            One place.
          </h1>
          <p>Your agents on each installation you run, side by side in one app.</p>
        </div>
        <small>Open by nature. Yours entirely.</small>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={submit}>
          <div className="login-lock">
            <Server size={24} />
          </div>
          <h2>Connect a gateway.</h2>
          <p>One you run on a server: its address and host token, as you sign in on the web.</p>
          <Field label="Address">
            <input
              name="url"
              type="url"
              placeholder="https://jian.example.com"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
          <Field label="Name" hint="How the gateway bar shows it. The address’s host when empty.">
            <input
              name="name"
              type="text"
              placeholder="Home server"
              autoComplete="off"
              maxLength={60}
            />
          </Field>
          <Field label="Host token">
            <input
              name="token"
              type="password"
              placeholder="Paste the gateway’s host token"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" busy={busy}>
            Connect
            <ArrowRight size={17} />
          </Button>
          <Button variant="quiet" onClick={cancel}>
            Cancel
          </Button>
          <p className="secure-note">
            <ShieldCheck size={16} />
            The token stays in this computer’s keychain and never reaches the panel itself.
          </p>
          <details className="login-help">
            <summary>
              <CircleHelp size={15} />
              Where do I find the token?
            </summary>
            <p>
              Use the value of <code>JIAN_API_TOKEN</code> from the gateway’s server configuration.
            </p>
          </details>
        </form>
      </section>
    </main>
  );
}
