import { Action, TextField } from '@jian/ui';
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

/**
 * The app's own gateway ended before it ever listened: its last words, which the owner can act
 * on or send on, the log they came from, and a way to start it again now. It keeps trying on its
 * own meanwhile.
 */
export function LocalFailed({ failure }: { failure: string }) {
  return (
    <Notice icon={<TriangleAlert size={22} />} title="This computer’s gateway could not start">
      <p className="text-sm text-muted">
        Jian runs a gateway of its own on this computer, and it stopped before it was ready. This is
        what it said last:
      </p>
      <pre className="selectable max-h-48 w-full overflow-auto rounded-lg border border-glass-edge bg-glass-hover p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-ink">
        {failure}
      </pre>
      <p className="text-sm text-muted">
        It tries again on its own. The full log is local-gateway.log, in the app’s log folder.
      </p>
      <div className="flex gap-2">
        <Action tone="primary" onClick={() => desktop().local.retry()}>
          Try again now
        </Action>
        <Action tone="outline" onClick={() => desktop().local.openLog()}>
          Show the log
        </Action>
      </div>
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
      <Action tone="outline" onClick={retry}>
        Try again now
      </Action>
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
        <TextField
          label="Host token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        {error && (
          <p className="text-sm text-bad" role="alert">
            {error}
          </p>
        )}
        <Action type="submit" tone="primary" busy={saving} disabled={!token.trim()}>
          Save token
        </Action>
      </form>
    </Notice>
  );
}
