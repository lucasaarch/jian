'use client';

import { useState } from 'react';
import {
  type MetaCredentials,
  metaCredentialsOf,
  metaPolicyUrl,
} from '../../components/channels/meta-credentials';
import { TextField } from '../../kit';

/** What Meta's Cloud API allows this channel, said before it is set up and while it runs. */
export function MetaLimits() {
  return (
    <p className="text-xs leading-relaxed text-muted">
      Inbound customer support only. Replies are allowed for 24 hours after the customer’s last
      message, never renewed by the agent’s own. No templates, proactive messages or groups; voice
      only as Ogg/Opus up to 16 MB. Contacts are not migrated from WhatsApp (Baileys). Check Meta’s{' '}
      <a href={metaPolicyUrl} className="text-ink underline-offset-2 hover:underline">
        AI-provider policy
      </a>{' '}
      and current pricing before a real deployment.
    </p>
  );
}

/**
 * The second step of Meta's setup: the four credentials Meta issues once its callback is
 * registered. Uncontrolled and in a form of their own — `id` lets the dialog's footer submit it —
 * so no secret is held in React state, and every submission clears them, a failed one too.
 */
export function MetaCredentialsForm({
  id,
  save,
}: {
  id: string;
  save: (credentials: MetaCredentials) => void;
}) {
  const [error, setError] = useState('');

  return (
    <form
      id={id}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = metaCredentialsOf(event.currentTarget);
        if ('error' in result) {
          setError(result.error);
          return;
        }
        setError('');
        save(result.credentials);
      }}
    >
      <p className="text-xs leading-relaxed text-muted">
        Complete the setup with what Meta issued. Saving does not activate an account, subscribe the
        webhook or confirm that messages arrive; the callback URL and verify token are kept.
      </p>
      <TextField
        label="Access token"
        name="accessToken"
        hint="A system-user token with the WhatsApp permissions."
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
      />
      <TextField
        label="App secret"
        name="appSecret"
        hint="Verifies the payloads Meta signs."
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
      />
      <TextField
        label="Phone number ID"
        name="phoneNumberId"
        hint="The Meta ID of the sending number, not the number."
        inputMode="numeric"
        pattern="[0-9]+"
        required
      />
      <TextField
        label="WhatsApp Business account ID"
        name="businessAccountId"
        hint="The WABA ID, not the business portfolio ID."
        inputMode="numeric"
        pattern="[0-9]+"
        required
      />
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
    </form>
  );
}
