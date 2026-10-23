import { Field } from '../ui';

/** Uncontrolled fields: no credentials in React state or browser storage; unmount on close. */
export function MetaCredentials() {
  return (
    <>
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
          [
            'verifyToken',
            'Verify token',
            'Choose a secret and enter the same value in Meta’s webhook setup.',
          ],
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
    </>
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
