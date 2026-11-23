import type { UpdateWebhook, UpdateWebhookInput, UpdateWebhookMethod } from '@jian/contracts';
import type { Pair } from './pairs-field';

export type WebhookDraft = {
  url: string;
  method: UpdateWebhookMethod;
  params: Pair[];
  headers: Pair[];
  body: string;
};

export const blankDraft = (): WebhookDraft => ({
  url: '',
  method: 'POST',
  params: [],
  headers: [],
  body: '',
});

/** What is sent to save it: rows with no name are left out, as is a body of blank space. */
export function webhookInput(draft: WebhookDraft): UpdateWebhookInput {
  const named = (list: Pair[]) =>
    list.map((pair) => ({ name: pair.name.trim(), value: pair.value })).filter((pair) => pair.name);
  return {
    url: draft.url.trim(),
    method: draft.method,
    params: named(draft.params),
    headers: named(draft.headers),
    ...(draft.body.trim() && draft.method !== 'GET' ? { body: draft.body } : {}),
  };
}

/** A saved webhook in one line: what the gateway shows of it, never a value. */
export function webhookSummary(webhook: UpdateWebhook): string {
  const parts = [`${webhook.method} ${webhook.origin}`];
  if (webhook.params.length) parts.push(`parameters ${webhook.params.join(', ')}`);
  if (webhook.headers.length) parts.push(`headers ${webhook.headers.join(', ')}`);
  if (webhook.body) parts.push('a body');
  return parts.join(' · ');
}
