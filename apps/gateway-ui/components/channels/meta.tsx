import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import type { ChannelPatch } from '../../lib/api';
import { Button, Field } from '../ui';

/** Uncontrolled fields: no credentials in React state or browser storage; unmount on close. */
export function MetaCredentials({
  busy,
  save,
}: {
  busy: boolean;
  save: (
    credentials: Extract<ChannelPatch, { whatsappBusiness: unknown }>['whatsappBusiness'],
  ) => void;
}) {
  const [error, setError] = useState('');
  return (
    <form
      method="post"
      action="/"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fields = new FormData(form);
        const credentials = {
          accessToken: String(fields.get('accessToken') ?? '').trim(),
          appSecret: String(fields.get('appSecret') ?? '').trim(),
          phoneNumberId: String(fields.get('phoneNumberId') ?? '').trim(),
          businessAccountId: String(fields.get('businessAccountId') ?? '').trim(),
        };
        // Clear before validation/request, including failed submissions.
        form.reset();
        if (Object.values(credentials).some((value) => !value)) {
          setError('Enter all four Meta credentials and IDs.');
          return;
        }
        setError('');
        save(credentials);
      }}
    >
      <h4>Complete Meta setup</h4>
      <p className="note">
        The existing verify token and callback URL are kept. This completes setup; it does not
        rotate credentials or verify that Meta has subscribed the webhook.
      </p>
      <p className="note">
        Create a Meta developer app with WhatsApp first. Saving credentials does not activate an
        account, subscribe a webhook, or confirm that messages can be delivered.
      </p>
      {(
        [
          [
            'accessToken',
            'Access token',
            'Use a system-user token with the required WhatsApp permissions.',
          ],
          ['appSecret', 'App secret', 'Used to verify signed webhook payloads from Meta.'],
        ] as const
      ).map(([name, label, hint]) => (
        <Field key={name} label={label} hint={hint}>
          <input name={name} type="password" autoComplete="off" spellCheck={false} required />
        </Field>
      ))}
      <Field
        label="Phone number ID"
        hint="The Meta ID of the sending number, not its phone number."
      >
        <input name="phoneNumberId" type="text" inputMode="numeric" pattern="[0-9]+" required />
      </Field>
      <Field
        label="WhatsApp Business account ID"
        hint="The WABA ID, not the Meta business portfolio ID."
      >
        <input name="businessAccountId" type="text" inputMode="numeric" pattern="[0-9]+" required />
      </Field>
      <p className="note">
        Secrets are sent only when you save, then cleared from this form. They are not saved in
        browser storage or shown again. Re-enter them if saving fails.
      </p>
      <Button type="submit" busy={busy}>
        Complete setup
      </Button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function MetaCallback({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  return (
    <div>
      <h4>Meta callback URL</h4>
      <textarea
        className="secret-value"
        aria-label="Meta callback URL"
        value={url}
        readOnly
        rows={2}
        spellCheck={false}
      />
      <Button
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setError('');
          } catch {
            setError('Select the URL above and copy it by hand.');
          }
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
        {copied ? 'Copied' : 'Copy callback URL'}
      </Button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="note">
        The generated channel ID is already included: do not paste a literal &lt;channelId&gt;
        placeholder into Meta. This URL uses the panel’s origin. If the panel is hosted separately,
        replace only the origin with the gateway’s exact public HTTPS origin, preserving the path.
      </p>
    </div>
  );
}

export function MetaLimits() {
  return (
    <p className="note">
      Inbound customer support only. The 24-hour customer-service window renews only when the
      customer sends a message, never when the agent replies. Replies after expiry are blocked. No
      templates, proactive messages, or groups in this prototype. Audio is limited to Ogg/Opus mono
      voice messages up to 16 MB, in both directions. Contacts and groups are not migrated between
      Meta and Baileys. Before real deployment, check Meta’s{' '}
      <a href="https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers">
        AI-provider policy
      </a>{' '}
      and current eligibility and pricing; official API access does not guarantee policy compliance
      or protection from restrictions.
    </p>
  );
}
