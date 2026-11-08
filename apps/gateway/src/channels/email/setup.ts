import type { emailInputSchema } from '@jian/contracts';
import type { z } from 'zod';
import { GatewayError } from '../../core/errors.js';
import { channelLog } from '../logging.js';
import { EMAIL_PROVIDERS } from './channel.js';
import { type EmailCredential, emailCredentialSchema, type Net } from './provider.js';

/**
 * Everything an email channel needs before it is stored: the key checked, the domain verified,
 * and the provider told where to deliver this channel's mail. `base` is where the outside world
 * reaches the gateway; without one the provider would have nowhere to send anything.
 */
export async function openEmail(
  input: z.infer<typeof emailInputSchema>,
  channelId: string,
  fromName: string,
  base: string | undefined,
  net: Net,
  providers = EMAIL_PROVIDERS,
): Promise<EmailCredential> {
  const account = { ...input, address: input.address.trim().toLowerCase() };
  const provider = providers[input.provider];

  await provider.verify(account, net);

  if (!base) {
    throw new GatewayError(
      400,
      'Email needs the address the internet reaches this gateway at. Set JIAN_PUBLIC_URL.',
    );
  }

  const webhook = await provider.subscribe(account, `${base}/v1/email/${channelId}`, net);

  return emailCredentialSchema.parse({
    ...account,
    fromName: fromName.slice(0, 100),
    ...webhook,
  });
}

/** Takes the channel's webhook off the provider; a failure leaves one that is refused anyway. */
export async function closeEmail(
  credential: EmailCredential,
  channelId: string,
  net: Net,
  providers = EMAIL_PROVIDERS,
): Promise<void> {
  try {
    await providers[credential.provider].unsubscribe(credential, net);
  } catch (error) {
    channelLog('email.unsubscribe.failed', { channelId }, error);
  }
}
