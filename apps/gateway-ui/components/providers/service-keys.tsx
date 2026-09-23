'use client';

import { ChevronDown, Globe, KeyRound, type LucideIcon, Save, Scale, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Field } from '../ui';

type Status = { configured: boolean; updatedAt?: string };
type RowProps = Pick<SectionProps, 'api' | 'mutate' | 'busy'>;

/**
 * A service the whole installation shares through one key. These rows sit beside the model
 * providers because each is a credential of the installation, but none of them chooses a model.
 */
function ServiceKeyRow({
  id,
  icon: Icon,
  title,
  vendor,
  children,
  source,
  load,
  save,
  remove,
  mutate,
  busy,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  vendor: string;
  children: ReactNode;
  source: string;
  load: () => Promise<Status>;
  save: (key: string) => Promise<Status>;
  remove: () => Promise<Status>;
} & Pick<SectionProps, 'mutate' | 'busy'>) {
  const [status, setStatus] = useState<Status>();
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    let active = true;
    void load()
      .then((state) => {
        if (active) setStatus(state);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [load]);

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
        <Icon size={18} />
      </div>
      <div className="grow">
        <h3>
          {title} · {vendor}
          <Badge tone={status?.configured ? 'good' : 'neutral'}>
            {status?.configured ? 'Connected' : 'Not configured'}
          </Badge>
        </h3>
        <p>{children}</p>
        <div className="connection-meta">
          <KeyRound size={13} />
          <span>
            {status?.configured && status.updatedAt
              ? `Key saved on ${date(status.updatedAt)}`
              : `A key from ${source}`}
          </span>
        </div>
      </div>
      <div className="row-actions">
        <Button
          type="button"
          variant="quiet"
          disabled={busy}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            setOpen(!open);
            setFormError('');
          }}
        >
          {open ? 'Close' : status?.configured ? 'Manage' : 'Connect'}
          <ChevronDown size={16} className={open ? 'rotate-180' : undefined} />
        </Button>
      </div>
      <div id={id} className="connection-disclosure basis-full" hidden={!open}>
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
              setFormError(`Enter the ${vendor} key.`);
              return;
            }
            if (await change(() => save(key), `${title} configured.`)) {
              element.reset();
            }
          }}
        >
          <Field label={`${vendor} key`} hint="What you save here is never shown again.">
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
                onClick={() => void change(remove, `${title} removed.`)}
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

export function WebSearchRow({ api, mutate, busy }: RowProps) {
  return (
    <ServiceKeyRow
      id="provider-web-search"
      icon={Globe}
      title="Web search"
      vendor="Tavily"
      source="tavily.com"
      load={api.webSearch}
      save={api.setWebSearch}
      remove={api.removeWebSearch}
      mutate={mutate}
      busy={busy}
    >
      Lets the profiles with web search switched on search the internet and read pages. The free
      plan covers 1,000 searches a month.
    </ServiceKeyRow>
  );
}

export function DecisionsRow({ api, mutate, busy }: RowProps) {
  return (
    <ServiceKeyRow
      id="provider-decisions"
      icon={Scale}
      title="Decisions"
      vendor="Jev"
      source="typesafe.ai"
      load={api.decisions}
      save={api.setDecisions}
      remove={api.removeDecisions}
      mutate={mutate}
      busy={busy}
    >
      Tells whether a group message that names an agent is speaking to it, and holds back shell
      commands and file changes that go further than what was asked. Without it, the fixed rules
      decide.
    </ServiceKeyRow>
  );
}
