'use client';

import type { UpdateComponent, UpdateWebhookMethod } from '@jian/contracts';
import { useEffect, useState } from 'react';
import { Action, Overlay, OverlayActions, SelectField, TextArea, TextField } from '../../kit';
import { PairsField } from './pairs-field';
import { blankDraft, type WebhookDraft, webhookInput } from './webhook-draft';

const METHODS: UpdateWebhookMethod[] = ['POST', 'PUT', 'PATCH', 'GET'];
const NAMES: Record<UpdateComponent, string> = { gateway: 'gateway', web: 'web panel' };

/**
 * Sets up one component's redeploy webhook, always typed in full: what is saved never comes back
 * to the panel, so replacing one means writing it again.
 */
export function WebhookDialog({
  component,
  onOpenChange,
  save,
  busy,
}: {
  /** The component whose webhook is set up; undefined while closed. */
  component: UpdateComponent | undefined;
  onOpenChange: (open: boolean) => void;
  save: (component: UpdateComponent, draft: WebhookDraft) => Promise<boolean>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(blankDraft);
  const [shown, setShown] = useState<UpdateComponent>('gateway');
  useEffect(() => {
    if (!component) return;
    setDraft(blankDraft());
    setShown(component);
  }, [component]);
  const change = (patch: Partial<WebhookDraft>) => setDraft((known) => ({ ...known, ...patch }));
  const name = NAMES[shown];

  return (
    <Overlay
      open={component !== undefined}
      onOpenChange={onOpenChange}
      title={`Redeploy webhook of the ${name}`}
      size="form"
    >
      <form
        className="grid w-full gap-5 p-7"
        onSubmit={(event) => {
          event.preventDefault();
          void save(shown, draft).then((saved) => saved && onOpenChange(false));
        }}
      >
        <header className="grid gap-1 pr-10">
          <h2 className="text-xl font-semibold tracking-tight">Webhook of the {name}</h2>
          <p className="text-sm text-muted">
            Your platform must deploy the exact tag it is sent, never <code>latest</code>.{' '}
            <code>{'{version}'}</code> becomes the release, such as 1.13.0, and{' '}
            <code>{'{component}'}</code> becomes {shown}, in the URL, the values and the body.
          </p>
        </header>
        <TextField
          label="URL"
          hint="On Cubeship: https://host/hooks/deploy/<token>, with a parameter tag = {version}."
          value={draft.url}
          onChange={(event) => change({ url: event.target.value })}
          placeholder="https://deploy.example.com/hooks/deploy/…"
          required
          autoComplete="off"
          spellCheck={false}
        />
        <SelectField
          label="Method"
          value={draft.method}
          options={METHODS.map((method) => ({ value: method, label: method }))}
          onValueChange={(method) => change({ method: method as UpdateWebhookMethod })}
        />
        <PairsField
          label="Query parameters"
          hint="Encoded and added after any query the URL has."
          placeholder="tag"
          list={draft.params}
          onChange={(params) => change({ params })}
        />
        <PairsField
          label="Headers"
          hint="Such as Authorization, for a platform that checks a secret."
          placeholder="Authorization"
          list={draft.headers}
          onChange={(headers) => change({ headers })}
        />
        {draft.method !== 'GET' && (
          <TextArea
            label="Body"
            hint="Sent as it is; leave it empty to send none."
            value={draft.body}
            onChange={(event) => change({ body: event.target.value })}
            placeholder={'{"tag": "{version}"}'}
            rows={3}
            spellCheck={false}
          />
        )}
        <p className="text-xs leading-snug text-muted">
          Saved encrypted. Only the address's host and the names of its parameters and headers are
          shown again.
        </p>
        <OverlayActions>
          <Action tone="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Action>
          <Action tone="primary" type="submit" busy={busy} disabled={!webhookInput(draft).url}>
            Save webhook
          </Action>
        </OverlayActions>
      </form>
    </Overlay>
  );
}
