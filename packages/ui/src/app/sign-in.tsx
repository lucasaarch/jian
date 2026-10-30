'use client';

import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Mark } from '../components/ui';
import { Action, Fold, FoldChevron, TextField } from '../kit';
import { gatewayApi } from '../lib/api';

/**
 * The way into a gateway from a browser: its host token, traded for a session cookie the
 * browser keeps. The token itself is never stored.
 */
export function SignIn({ connected }: { connected: () => void }) {
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);

  // The page is drawn on the server first: it must not submit a secret before React has
  // attached its handler, or the browser would post the form itself.
  useEffect(() => setReady(true), []);

  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <form
        method="post"
        action="/"
        className="glass-strong grid w-full max-w-sm gap-5 rounded-[1.375rem] p-7 phone:p-6"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          const token = String(new FormData(event.currentTarget).get('token')).trim();
          const api = gatewayApi();
          try {
            await api.signIn(token);
            await api.profiles();
            connected();
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Could not reach the gateway.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <header className="grid justify-items-start gap-3">
          <span className="size-9 text-ink [&_svg]:size-full">
            <Mark />
          </span>
          <div className="grid gap-1">
            <h1 className="font-sans text-xl font-semibold tracking-tight">Connect to Jian</h1>
            <p className="text-sm">Sign in with this installation's host token.</p>
          </div>
        </header>
        <TextField
          label="Host token"
          name="token"
          type="password"
          placeholder="Paste your access token"
          autoComplete="off"
          required
          minLength={32}
          spellCheck={false}
        />
        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
        <Action type="submit" tone="primary" busy={busy} disabled={!ready}>
          Enter the gateway
          <ArrowRight size={16} />
        </Action>
        <p className="flex items-start gap-2 text-xs leading-snug">
          <ShieldCheck size={14} className="mt-px" aria-hidden="true" />
          The token is not stored in this browser. The session lasts 30 days.
        </p>
        <div className="grid gap-1 border-t border-glass-edge pt-3">
          <button
            type="button"
            aria-expanded={help}
            aria-controls="sign-in-help"
            onClick={() => setHelp(!help)}
            className="flex w-fit items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-ink"
          >
            Where do I find my token?
            <FoldChevron open={help} />
          </button>
          <Fold open={help} id="sign-in-help">
            <p className="pt-1 text-xs leading-relaxed">
              Use the value of <code>JIAN_API_TOKEN</code> from the server configuration. It is the
              only token the gateway accepts.
            </p>
          </Fold>
        </div>
      </form>
    </main>
  );
}
