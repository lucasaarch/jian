'use client';

import { ChevronDown, Globe, KeyRound, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GatewayApi } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Field } from '../ui';

type Status = Awaited<ReturnType<GatewayApi['webSearch']>>;

/**
 * The search service every agent with web search switched on uses. It sits beside the model
 * providers because it is a credential of the installation, but it chooses no model.
 */
export function WebSearchRow({ api, mutate, busy }: Pick<SectionProps, 'api' | 'mutate' | 'busy'>) {
  const [status, setStatus] = useState<Status>();
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    let active = true;
    void api
      .webSearch()
      .then((state) => {
        if (active) setStatus(state);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api]);

  const change = async (action: () => Promise<Status>, done: string) => {
    let next: Status | undefined;
    const ok = await mutate(async () => {
      next = await action();
    }, done);
    if (ok && next) setStatus(next);
    return ok;
  };

  return (
    <article className="resource-row items-start provider-row">
      <div className="resource-icon provider-symbol" aria-hidden="true">
        <Globe size={18} />
      </div>
      <div className="grow">
        <h3>
          Web search · Tavily
          <Badge tone={status?.configured ? 'good' : 'neutral'}>
            {status?.configured ? 'Connected' : 'Not configured'}
          </Badge>
        </h3>
        <p>
          Lets the profiles with web search switched on search the internet and read pages. The free
          plan covers 1,000 searches a month.
        </p>
        <div className="connection-meta">
          <KeyRound size={13} />
          <span>
            {status?.configured && status.updatedAt
              ? `Key saved on ${date(status.updatedAt)}`
              : 'A key from tavily.com'}
          </span>
        </div>
      </div>
      <div className="row-actions">
        <Button
          type="button"
          variant="quiet"
          disabled={busy}
          aria-expanded={open}
          aria-controls="provider-web-search"
          onClick={() => {
            setOpen(!open);
            setFormError('');
          }}
        >
          {open ? 'Close' : status?.configured ? 'Manage' : 'Connect'}
          <ChevronDown size={16} className={open ? 'rotate-180' : undefined} />
        </Button>
      </div>
      <div id="provider-web-search" className="connection-disclosure basis-full" hidden={!open}>
        <form
          className="connection-form"
          method="post"
          action="/ui/"
          onSubmit={async (event) => {
            event.preventDefault();
            setFormError('');
            const element = event.currentTarget;
            const key = String(new FormData(element).get('secret') ?? '').trim();
            if (!key) {
              setFormError('Enter the Tavily key.');
              return;
            }
            if (await change(() => api.setWebSearch(key), 'Web search configured.')) {
              element.reset();
            }
          }}
        >
          <Field label="Tavily key" hint="What you save here is never shown again.">
            <input name="secret" type="password" autoComplete="off" required />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" busy={busy}>
              <Save size={16} />
              {status?.configured ? 'Replace it' : 'Save it'}
            </Button>
            {status?.configured && (
              <Button
                type="button"
                variant="quiet"
                disabled={busy}
                onClick={() => void change(() => api.removeWebSearch(), 'Web search removed.')}
              >
                <Trash2 size={16} />
                Remove it
              </Button>
            )}
          </div>
          {formError && open && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
        </form>
      </div>
    </article>
  );
}
