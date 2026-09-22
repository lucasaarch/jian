'use client';

import { ArrowUpRight, ChevronDown, KeyRound, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GatewayApi } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Field, SectionHeading } from '../ui';
import { providers } from './catalog';

export function Providers({ data, api, mutate, busy }: SectionProps) {
  const [editing, setEditing] = useState<string>();
  const [formError, setFormError] = useState('');
  const [codexLogin, setCodexLogin] = useState<Awaited<ReturnType<GatewayApi['codexLogin']>>>();

  useEffect(() => {
    let active = true;
    void api
      .codexLogin()
      .then((state) => {
        if (active) setCodexLogin(state);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (codexLogin?.status !== 'pending') return;
    const timer = setInterval(() => {
      void api
        .codexLogin()
        .then((state) => {
          setCodexLogin(state);
          if (state.status === 'connected') void mutate(async () => {}, 'ChatGPT conectado.');
        })
        .catch(() => setCodexLogin({ status: 'failed', error: 'The login could not be checked.' }));
    }, 5000);
    return () => clearInterval(timer);
  }, [api, codexLogin?.status, mutate]);

  return (
    <>
      <SectionHeading
        title="Providers"
        description="Connect once, use from every profile. Each profile picks its own model under Model defaults."
      />
      <div className="connections-grid providers-grid">
        {providers.map((entry) => {
          const configured = data.providers.find(
            (provider) => provider.kind === entry.kind && !provider.revokedAt,
          );
          const list = configured ? data.providerModels[configured.id] : undefined;
          const uncatalogued = list?.models.filter((model) => !model.known).length ?? 0;
          return (
            <article className="connection-card" data-connected={!!configured} key={entry.kind}>
              <header className="connection-card-header">
                <span className="provider-symbol" aria-hidden="true">
                  {{ openai: '◎', anthropic: 'A', google: '✦', openrouter: '⇄' }[entry.kind]}
                </span>
                <Badge tone={configured ? 'good' : 'neutral'}>
                  {configured
                    ? configured.authMode === 'codex'
                      ? 'ChatGPT connected'
                      : 'Connected'
                    : 'Not configured'}
                </Badge>
              </header>
              <h2>{entry.name}</h2>
              <p className="connection-description">
                {
                  {
                    openrouter: 'One account, many models.',
                    anthropic: 'Claude models for your agents.',
                    google: "Google's Gemini models.",
                    openai: 'The OpenAI API, or your ChatGPT account.',
                  }[entry.kind]
                }
              </p>
              <div className="connection-meta">
                {configured ? (
                  <>
                    <KeyRound size={13} />
                    <span>
                      {configured.apiKeyEnv
                        ? 'Credencial do ambiente'
                        : configured.authMode === 'codex'
                          ? 'Login ChatGPT'
                          : `Chave salva em ${date(configured.createdAt)}`}
                    </span>
                  </>
                ) : (
                  <span>Credentials encrypted</span>
                )}
                {list && !list.stale && (
                  <span>
                    {list.models.length} models available
                    {uncatalogued > 0 && ` · ${uncatalogued} with unknown capabilities`}
                  </span>
                )}
              </div>
              {list?.stale && (
                <p className="note" role="status">
                  {list.models.length ? `List from ${date(list.fetchedAt)}. ` : ''}
                  {list.reason ?? 'The model list could not be refreshed.'}
                </p>
              )}
              <button
                type="button"
                className="connection-action"
                aria-expanded={editing === entry.kind}
                aria-controls={`provider-${entry.kind}`}
                disabled={busy}
                onClick={() => {
                  setEditing(editing === entry.kind ? undefined : entry.kind);
                  setFormError('');
                }}
              >
                {editing === entry.kind ? 'Close' : configured ? 'Manage connection' : 'Connect'}
                {editing === entry.kind ? <ChevronDown size={16} /> : <ArrowUpRight size={16} />}
              </button>
              <div
                id={`provider-${entry.kind}`}
                className="connection-disclosure"
                hidden={editing !== entry.kind}
              >
                <form
                  className="connection-form"
                  method="post"
                  action="/ui/"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    setFormError('');
                    const element = event.currentTarget;
                    const secret = String(new FormData(element).get('secret') ?? '').trim();
                    if (!secret) {
                      setFormError(`Informe a chave de ${entry.name}.`);
                      return;
                    }
                    // Registering replaces the provider of this vendor, key included.
                    const ok = await mutate(
                      () =>
                        api.createProvider({
                          name: entry.name,
                          kind: entry.kind,
                          secret,
                        }),
                      `${entry.name} configurado.`,
                    );
                    if (ok) element.reset();
                  }}
                >
                  <Field
                    label={`${entry.name} key`}
                    hint={
                      configured?.apiKeyEnv
                        ? `Current key: ${configured.apiKeyEnv}. A new key replaces the one from the environment.`
                        : 'What you save here is never shown again.'
                    }
                  >
                    <input name="secret" type="password" autoComplete="off" required />
                  </Field>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="submit" busy={busy}>
                      <Save size={16} />
                      {configured ? 'Replace the key' : 'Save the key'}
                    </Button>
                    {configured && !configured.apiKeyEnv && (
                      <Button
                        type="button"
                        variant="quiet"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            () => api.revokeProvider(configured.id),
                            `${entry.name} desconectado.`,
                          )
                        }
                      >
                        <Trash2 size={16} />
                        {configured.authMode === 'codex' ? 'Disconnect ChatGPT' : 'Remove the key'}
                      </Button>
                    )}
                  </div>
                  {entry.kind === 'openai' && (
                    <div className="mt-5 border-t border-line pt-5">
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={busy || codexLogin?.status === 'pending'}
                        onClick={() =>
                          void api
                            .startCodexLogin()
                            .then(setCodexLogin)
                            .catch((error) =>
                              setFormError(
                                error instanceof Error
                                  ? error.message
                                  : 'The login is unavailable.',
                              ),
                            )
                        }
                      >
                        Sign in with ChatGPT
                      </Button>
                      {codexLogin?.status === 'pending' && (
                        <p className="note">
                          Open{' '}
                          <a href={codexLogin.verificationUrl} target="_blank" rel="noreferrer">
                            the OpenAI login
                          </a>{' '}
                          and enter the code <strong>{codexLogin.userCode}</strong>.
                        </p>
                      )}
                      {codexLogin?.status === 'failed' && codexLogin.error && (
                        <p className="form-error" role="alert">
                          {codexLogin.error}
                        </p>
                      )}
                    </div>
                  )}
                  {formError && editing === entry.kind && (
                    <p className="form-error" role="alert">
                      {formError}
                    </p>
                  )}
                </form>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
