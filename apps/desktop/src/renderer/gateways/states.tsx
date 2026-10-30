import { Button, Field, Mark } from '@jian/ui';
import { CloudOff, KeyRound, TriangleAlert } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import type { GatewaySummary } from '../../shared/bridge';
import { desktop } from '../desktop';

/** A gateway that cannot be shown, and what the owner can do about it. */
function Notice({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="grid h-(--app-height) place-items-center bg-canvas px-6 text-ink">
      <section role="alert" className="flex max-w-md flex-col items-start gap-3">
        <span className="text-warn" aria-hidden="true">
          {icon}
        </span>
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
      </section>
    </main>
  );
}

/** The app's own gateway, between the app opening and the gateway answering. */
export function Starting() {
  return (
    <main
      className="grid h-(--app-height) place-items-center bg-canvas text-ink"
      aria-busy="true"
      aria-label="Starting Jian"
    >
      <span className="size-12 animate-pulse text-ink [&_svg]:size-full">
        <Mark />
      </span>
    </main>
  );
}

/** The gateway runs another major.minor: the panel built into this app would misread it. */
export function Incompatible({ gateway }: { gateway: GatewaySummary }) {
  const app = desktop().version;
  return (
    <Notice
      icon={<TriangleAlert size={22} />}
      title="This gateway and the app are on different releases"
    >
      <p className="text-sm text-muted">
        <strong className="text-ink">{gateway.name}</strong> runs{' '}
        <strong className="text-ink">{gateway.version}</strong> and this app is{' '}
        <strong className="text-ink">{app}</strong>. They only work together on the same major.minor
        release.
      </p>
      <p className="text-sm text-muted">
        Update the gateway to the app’s release, then it opens here again. Your other gateways keep
        working meanwhile.
      </p>
    </Notice>
  );
}

/** The gateway does not answer, or refuses the token this computer keeps for it. */
export function Unreachable({ gateway, retry }: { gateway: GatewaySummary; retry: () => void }) {
  if (gateway.status === 'unauthorized') return <ReplaceToken gateway={gateway} done={retry} />;
  return (
    <Notice icon={<CloudOff size={22} />} title={`${gateway.name} is not answering`}>
      <p className="text-sm text-muted">
        The app could not reach <span className="font-mono text-ink">{gateway.url}</span>. It keeps
        trying in the background and opens the panel as soon as the gateway answers.
      </p>
      <Button variant="secondary" onClick={retry}>
        Try again now
      </Button>
    </Notice>
  );
}

function ReplaceToken({ gateway, done }: { gateway: GatewaySummary; done: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const result = await desktop().replaceToken(gateway.id, token);
    setSaving(false);
    if (result.ok) done();
    else setError(result.error);
  };

  return (
    <Notice icon={<KeyRound size={22} />} title={`${gateway.name} refused the saved token`}>
      <p className="text-sm text-muted">
        Its host token was probably rotated on the server. Enter the current one; the app keeps it
        in this computer’s keychain.
      </p>
      <form className="flex w-full flex-col gap-2" onSubmit={submit}>
        <Field label="Host token">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" busy={saving} disabled={!token.trim()}>
          Save token
        </Button>
      </form>
    </Notice>
  );
}
