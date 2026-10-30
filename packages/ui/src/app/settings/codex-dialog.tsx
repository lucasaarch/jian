'use client';

import { type ReactNode, useState } from 'react';
import type { SectionActions } from '../../components/props';
import { useCodexLogin } from '../../components/providers/use-codex-login';
import { Action, Overlay, StatusPill } from '../../kit';
import type { Provider } from '../../lib/api';
import { CodexCodeDialog } from './codex-code-dialog';
import { ProviderTitle } from './provider-title';

/**
 * Codex: OpenAI through the owner's ChatGPT plan instead of an API key, configured — signing
 * in, the wait for the code to be entered, and disconnecting, which the page asks to confirm.
 */
export function CodexDialog({
  open,
  onOpenChange,
  codex,
  apiKey,
  actions: { api, mutate, busy },
  onDisconnect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sign-in in place, if any. */
  codex: Provider | undefined;
  /** Whether an OpenAI API key is connected beside it. */
  apiKey: boolean;
  actions: SectionActions;
  onDisconnect: (provider: Provider) => void;
}) {
  const { login, codeShown, start, showCode, hideCode } = useCodexLogin(api, mutate);
  const [startError, setStartError] = useState('');
  const pending = login?.status === 'pending';
  // The code to enter, while a sign-in waits for it.
  const code =
    pending && login.verificationUrl && login.userCode
      ? { url: login.verificationUrl, userCode: login.userCode }
      : undefined;

  const signIn = async () => {
    setStartError('');
    try {
      await start();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'The login is unavailable.');
    }
  };

  const failure = startError || (login?.status === 'failed' ? login.error : undefined);
  let state: ReactNode = 'Your ChatGPT plan instead of an OpenAI API key.';
  if (failure) {
    state = (
      <span role="alert" className="text-bad">
        {failure}
      </span>
    );
  } else if (code) {
    state = (
      <>
        Waiting for the ChatGPT sign-in.{' '}
        <button
          type="button"
          onClick={showCode}
          className="text-ink underline-offset-2 hover:underline"
        >
          Show the code
        </button>
      </>
    );
  } else if (codex) {
    state = apiKey
      ? 'Signed in with your ChatGPT plan.'
      : 'Signed in with your ChatGPT plan. An API key alongside it adds image and voice generation.';
  }

  return (
    <>
      <Overlay open={open} onOpenChange={onOpenChange} title="Codex" size="form">
        <div className="grid w-full gap-5 p-7">
          <header className="grid gap-1.5 pr-6">
            <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
              <ProviderTitle kind="openai">Codex</ProviderTitle>
              {codex && <StatusPill tone="good">Connected</StatusPill>}
            </h2>
            <p className="text-sm leading-relaxed text-muted">{state}</p>
          </header>
          <div className="flex items-center gap-2">
            {codex && (
              <Action
                tone="danger"
                className="bg-bad/10"
                disabled={busy}
                onClick={() => onDisconnect(codex)}
              >
                Disconnect
              </Action>
            )}
            <span className="flex-1" />
            <Action tone="quiet" onClick={() => onOpenChange(false)}>
              Close
            </Action>
            <Action tone="primary" busy={busy || pending} onClick={signIn}>
              {codex ? 'Sign in again' : 'Sign in'}
            </Action>
          </div>
        </div>
      </Overlay>
      {code && codeShown && (
        <CodexCodeDialog
          verificationUrl={code.url}
          userCode={code.userCode}
          copied={codeShown.copied}
          close={hideCode}
        />
      )}
    </>
  );
}
