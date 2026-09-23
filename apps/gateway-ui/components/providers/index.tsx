'use client';

import { ChevronDown, KeyRound, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GatewayApi } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Field, SectionHeading } from '../ui';
import { Select } from '../ui/select';
import { anthropicCredentials, providers } from './catalog';

/** What the row says about the credential in place, in one line. */
function credentialLine(provider: {
  apiKeyEnv?: string;
  authMode?: string;
  credential?: string;
  createdAt: string;
}) {
  if (provider.apiKeyEnv) {
    return `From the environment · ${provider.apiKeyEnv}`;
  }

  if (provider.authMode === 'codex') {
    return 'ChatGPT login';
  }

  const kind = provider.credential === 'subscription' ? 'Subscription token' : 'Key';

  return `${kind} saved on ${date(provider.createdAt)}`;
}

export function Providers({ data, api, mutate, busy }: SectionProps) {
  const [editing, setEditing] = useState<string>();
  const [formError, setFormError] = useState('');
  const [credential, setCredential] = useState('key');
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
          if (state.status === 'connected') void mutate(async () => {}, 'ChatGPT connected.');
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
      <div className="resource-list">
        {providers.map((entry) => {
          const configured = data.providers.find(
            (provider) =>
              provider.kind === entry.kind && !provider.revokedAt && provider.authMode !== 'codex',
          );
          const codex = data.providers.find(
            (provider) =>
              provider.kind === entry.kind && provider.authMode === 'codex' && !provider.revokedAt,
          );
          const list = configured ? data.providerModels[configured.id] : undefined;
          const uncatalogued = list?.models.filter((model) => !model.known).length ?? 0;
          const open = editing === entry.kind;
          return (
            <article className="resource-row items-start provider-row" key={entry.kind}>
              <div className="resource-icon provider-symbol" aria-hidden="true">
                {entry.symbol}
              </div>
              <div className="grow">
                <h3>
                  {entry.name}
                  <Badge tone={configured || codex ? 'good' : 'neutral'}>
                    {configured ? 'Connected' : codex ? 'ChatGPT connected' : 'Not configured'}
                  </Badge>
                </h3>
                <p>{entry.description}</p>
                {entry.kind === 'openai' && codexLogin?.status === 'connected' && (
                  <p>
                    ChatGPT is connected. An API key can be configured alongside it for image and
                    voice generation.
                  </p>
                )}
                <div className="connection-meta">
                  <KeyRound size={13} />
                  <span>{configured ? credentialLine(configured) : entry.variables}</span>
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
              </div>
              <div className="row-actions">
                <Button
                  type="button"
                  variant="quiet"
                  disabled={busy}
                  aria-expanded={open}
                  aria-controls={`provider-${entry.kind}`}
                  onClick={() => {
                    setEditing(open ? undefined : entry.kind);
                    setCredential(configured?.credential ?? 'key');
                    setFormError('');
                  }}
                >
                  {open ? 'Close' : configured ? 'Manage' : 'Connect'}
                  <ChevronDown size={16} className={open ? 'rotate-180' : undefined} />
                </Button>
              </div>
              <div
                id={`provider-${entry.kind}`}
                className="connection-disclosure basis-full"
                hidden={!open}
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
                      setFormError(`Enter the ${entry.name} credential.`);
                      return;
                    }
                    // Registering replaces the provider of this vendor, key included.
                    const ok = await mutate(
                      () =>
                        api.createProvider({
                          name: entry.name,
                          kind: entry.kind,
                          secret,
                          ...(entry.kind === 'anthropic'
                            ? { credential: credential as 'key' | 'subscription' }
                            : {}),
                        }),
                      `${entry.name} configured.`,
                    );
                    if (ok) element.reset();
                  }}
                >
                  {entry.kind === 'anthropic' && (
                    <Field
                      label="Credential type"
                      hint="Anthropic refuses either one sent as the other."
                    >
                      <Select
                        value={credential}
                        onValueChange={setCredential}
                        options={[...anthropicCredentials]}
                        aria-label="Credential type"
                      />
                    </Field>
                  )}
                  <Field
                    label={`${entry.name} credential`}
                    hint={
                      configured?.apiKeyEnv
                        ? `Currently ${configured.apiKeyEnv}. What you save here replaces it.`
                        : 'What you save here is never shown again.'
                    }
                  >
                    <input name="secret" type="password" autoComplete="off" required />
                  </Field>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="submit" busy={busy}>
                      <Save size={16} />
                      {configured ? 'Replace it' : 'Save it'}
                    </Button>
                    {configured && !configured.apiKeyEnv && (
                      <Button
                        type="button"
                        variant="quiet"
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            () => api.revokeProvider(configured.id),
                            `${entry.name} disconnected.`,
                          )
                        }
                      >
                        <Trash2 size={16} />
                        {configured.authMode === 'codex' ? 'Disconnect ChatGPT' : 'Remove it'}
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
                      {codex && (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={busy}
                          onClick={() =>
                            void mutate(() => api.revokeProvider(codex.id), 'ChatGPT disconnected.')
                          }
                        >
                          Disconnect ChatGPT
                        </Button>
                      )}
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
                  {formError && open && (
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
