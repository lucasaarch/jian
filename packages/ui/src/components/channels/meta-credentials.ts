import type { ChannelPatch } from '../../lib/api';

export type MetaCredentials = Extract<
  ChannelPatch,
  { whatsappBusiness: unknown }
>['whatsappBusiness'];

const read = (fields: FormData, name: string) => String(fields.get(name) ?? '').trim();

/**
 * Meta's four credentials read from an uncontrolled form, which is cleared at once: no secret
 * lives in React state or browser storage, and a failed save asks for them again.
 */
export function metaCredentialsOf(
  form: HTMLFormElement,
): { credentials: MetaCredentials } | { error: string } {
  const fields = new FormData(form);
  const credentials = {
    accessToken: read(fields, 'accessToken'),
    appSecret: read(fields, 'appSecret'),
    phoneNumberId: read(fields, 'phoneNumberId'),
    businessAccountId: read(fields, 'businessAccountId'),
  };

  // Cleared before validation and the request, including failed submissions.
  form.reset();

  return Object.values(credentials).some((value) => !value)
    ? { error: 'Enter all four Meta credentials and IDs.' }
    : { credentials };
}

/** The verify token Meta's callback is created with, read and cleared as the credentials are. */
export function verifyTokenOf(form: HTMLFormElement): { verifyToken: string } | { error: string } {
  const verifyToken = read(new FormData(form), 'verifyToken');

  form.reset();

  return verifyToken ? { verifyToken } : { error: 'Enter a verify token.' };
}

/** Where Meta's own terms are read before a real deployment. */
export const metaPolicyUrl =
  'https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers';
