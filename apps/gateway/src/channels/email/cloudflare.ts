import { createHash, randomBytes } from 'node:crypto';
import { fileNameOf } from '@jian/contracts';
import { z } from 'zod';
import { GatewayError } from '../../core/errors.js';
import type { DeliveryOutcome } from '../channel.js';
import { receivedMail, WORKER_SOURCE, workerSigned } from './cloudflare-mail.js';
import type {
  EmailCredential,
  EmailInput,
  EmailProvider,
  Net,
  OutgoingEmail,
  Subscription,
  WebhookHeaders,
} from './provider.js';
import { bareAddress, displayNameOf } from './text.js';

/** What Cloudflare needs of a channel's credential: the token and the account it acts in. */
type Account = { apiKey: string; accountId: string };

/** The Cloudflare side of a channel's input or credential; another provider's is a bug. */
function own<T extends { provider: string }>(value: T): Extract<T, { provider: 'cloudflare' }> {
  if (value.provider !== 'cloudflare') throw new Error('Not a Cloudflare channel');
  return value as Extract<T, { provider: 'cloudflare' }>;
}

const API = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 20_000;
/** The Workers runtime the forwarding Worker is written for; a fixed date never moves under it. */
const COMPATIBILITY_DATE = '2025-09-01';
/** Cloudflare's ceiling for one message, attachments counted as base64 (platform/limits). */
const MAX_SEND_BYTES = 25 * 1024 * 1024;

const envelopeSchema = z.object({
  success: z.boolean().optional(),
  errors: z.array(z.object({ message: z.string() }).partial()).nullish(),
  result: z.unknown().optional(),
});

type Answer = { status: number; ok: boolean; result: unknown; message: string };

/** The Worker of one channel: named after its webhook, so a second connect never reuses one. */
export const workerName = (endpoint: string) =>
  `jian-email-${createHash('sha256').update(endpoint).digest('hex').slice(0, 24)}`;

/** `"Mia" <mia@example.com>` as Cloudflare takes a sender: the address and its name apart. */
function senderOf(from: string) {
  const address = bareAddress(from) ?? from;
  const name = displayNameOf(from);
  return name ? { address, name } : address;
}

export class Cloudflare implements EmailProvider {
  /**
   * One API call, with the envelope Cloudflare wraps every answer in read. A network failure
   * throws; any answer, refused or not, comes back for the caller to judge.
   */
  private async call(apiKey: string, path: string, init: RequestInit, net: Net): Promise<Answer> {
    const response = await net.fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
        authorization: `Bearer ${apiKey}`,
      },
      redirect: 'error',
      signal: AbortSignal.any([net.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const body = envelopeSchema.safeParse(await response.json().catch(() => undefined)).data;
    // Cloudflare's own words, kept short: they are shown to the owner as they are.
    const said = body?.errors?.find((error) => error.message)?.message;
    return {
      status: response.status,
      ok: response.ok && body?.success !== false,
      result: body?.result,
      message: said ? said.replace(/\s+/g, ' ').slice(0, 200) : `HTTP ${response.status}`,
    };
  }

  /** `call`, with a network failure as the owner reads it. */
  private async ask(apiKey: string, path: string, init: RequestInit, net: Net, doing: string) {
    try {
      return await this.call(apiKey, path, init, net);
    } catch {
      throw new GatewayError(502, `Cloudflare could not be reached to ${doing}. Try again.`);
    }
  }

  private refused(answer: Answer, doing: string, permission: string): never {
    if (answer.status === 401 || answer.status === 403) {
      throw new GatewayError(
        400,
        `Cloudflare refused this API token to ${doing} (${answer.message}). Give it ${permission}.`,
      );
    }
    throw new GatewayError(
      answer.status >= 500 ? 502 : 400,
      `Cloudflare could not ${doing}: ${answer.message}`,
    );
  }

  /** The zone the address's domain belongs to, from the domain itself up to its parent zones. */
  private async zone({ apiKey, accountId }: Account, domain: string, net: Net) {
    const labels = domain.split('.');
    for (let start = 0; start < labels.length - 1; start++) {
      const name = labels.slice(start).join('.');
      const query = `name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(accountId)}`;
      const answer = await this.ask(apiKey, `/zones?${query}`, {}, net, 'look up the domain');
      if (!answer.ok) this.refused(answer, 'look up the domain', 'Zone › Zone: Read');
      const found = z.array(z.object({ id: z.string().min(1).max(64) })).safeParse(answer.result);
      if (!found.success)
        throw new GatewayError(502, 'Cloudflare answered the zone list unexpectedly.');
      if (found.data[0]) return found.data[0].id;
    }
    throw new GatewayError(400, `${domain} is not a zone in this Cloudflare account.`);
  }

  async verify(given: EmailInput, net: Net) {
    const input = own(given);
    const domain = input.address.split('@')[1]?.toLowerCase() ?? '';
    const zoneId = await this.zone(input, domain, net);
    const doing = 'read Email Routing';
    const answer = await this.ask(
      input.apiKey,
      `/zones/${encodeURIComponent(zoneId)}/email/routing`,
      {},
      net,
      doing,
    );
    if (!answer.ok) this.refused(answer, doing, 'Zone › Zone Settings: Read');
    const routing = z
      .object({ enabled: z.boolean().optional(), status: z.string().optional() })
      .safeParse(answer.result).data;
    if (!routing?.enabled || (routing.status && routing.status !== 'ready')) {
      throw new GatewayError(
        400,
        `Email Routing is not ready on ${domain}. Enable it in the Cloudflare dashboard and add its DNS records.`,
      );
    }
  }

  async subscribe(given: EmailInput, endpoint: string, net: Net): Promise<Subscription> {
    const input = own(given);
    const domain = input.address.split('@')[1]?.toLowerCase() ?? '';
    const zoneId = await this.zone(input, domain, net);
    const script = workerName(endpoint);
    const signingSecret = randomBytes(32).toString('base64url');

    const form = new FormData();
    form.append(
      'metadata',
      new Blob(
        [
          JSON.stringify({
            main_module: 'worker.js',
            compatibility_date: COMPATIBILITY_DATE,
            bindings: [
              { type: 'plain_text', name: 'JIAN_ENDPOINT', text: endpoint },
              { type: 'secret_text', name: 'JIAN_SECRET', text: signingSecret },
            ],
          }),
        ],
        { type: 'application/json' },
      ),
    );
    form.append(
      'worker.js',
      new Blob([WORKER_SOURCE], { type: 'application/javascript+module' }),
      'worker.js',
    );
    const scriptPath = `/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${script}`;
    const uploaded = await this.ask(
      input.apiKey,
      scriptPath,
      { method: 'PUT', body: form },
      net,
      'upload the email Worker',
    );
    if (!uploaded.ok) this.refused(uploaded, 'upload the email Worker', 'Workers Scripts: Edit');

    const doing = 'create the routing rule';
    const rule = await this.ask(
      input.apiKey,
      `/zones/${encodeURIComponent(zoneId)}/email/routing/rules`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: `Jian: ${input.address}`.slice(0, 256),
          enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: input.address }],
          actions: [{ type: 'worker', value: [script] }],
        }),
      },
      net,
      doing,
    ).catch(async (error: unknown) => {
      await this.remove(input.apiKey, scriptPath, net).catch(() => undefined);
      throw error;
    });
    const created = z.object({ id: z.string().min(1).max(64) }).safeParse(rule.result);
    if (!rule.ok || !created.success) {
      // A Worker no rule calls is only clutter in the owner's account; take it back.
      await this.remove(input.apiKey, scriptPath, net).catch(() => undefined);
      if (!rule.ok) this.refused(rule, doing, 'Zone › Email Routing Rules: Edit');
      throw new GatewayError(502, 'Cloudflare created the routing rule without its id.');
    }
    return { webhookId: script, signingSecret, zoneId, ruleId: created.data.id };
  }

  /** Deletes what a path names; already gone is what was asked for. */
  private async remove(apiKey: string, path: string, net: Net) {
    const answer = await this.call(apiKey, path, { method: 'DELETE' }, net);
    if (!answer.ok && answer.status !== 404) {
      throw new GatewayError(502, `Cloudflare did not delete ${path} (${answer.message})`);
    }
  }

  async unsubscribe(credential: EmailCredential, net: Net) {
    const { apiKey, accountId, zoneId, ruleId, webhookId } = own(credential);
    const rule = `/zones/${encodeURIComponent(zoneId)}/email/routing/rules/${encodeURIComponent(ruleId)}`;
    const script = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(webhookId)}?force=true`;
    // Each is tried even when the other fails: either one gone stops mail reaching the channel.
    let failure: unknown;
    for (const path of [rule, script]) {
      try {
        await this.remove(apiKey, path, net);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  authentic(raw: Buffer, headers: WebhookHeaders, secret: string) {
    return workerSigned(raw, headers, secret);
  }

  async event(raw: Buffer, headers: WebhookHeaders) {
    const email = await receivedMail(raw, headers);
    return { emailId: email.id, recipients: email.receivedFor, email };
  }

  async send(
    stored: EmailCredential,
    email: OutgoingEmail,
    _idempotencyKey: string,
    net: Net,
  ): Promise<DeliveryOutcome> {
    const credential = own(stored);
    const headers = {
      ...(email.inReplyTo ? { 'In-Reply-To': email.inReplyTo } : {}),
      ...(email.references ? { References: email.references } : {}),
    };
    const body = {
      from: senderOf(email.from),
      to: [email.to],
      ...(email.cc?.length ? { cc: email.cc } : {}),
      subject: email.subject,
      text: email.text || ' ',
      ...(email.html ? { html: email.html } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(email.attachments?.length
        ? {
            attachments: email.attachments.map((file) => ({
              content: file.data,
              filename: fileNameOf(file.mimeType, file.name),
              type: file.mimeType,
              disposition: 'attachment',
            })),
          }
        : {}),
    };
    const json = JSON.stringify(body);
    // Refused before it leaves: Cloudflare would refuse it too, after taking all of it.
    if (Buffer.byteLength(json) > MAX_SEND_BYTES) {
      return {
        status: 'failed',
        remoteMessageIds: [],
        error: 'This email is over Cloudflare’s 25 MB limit. Send fewer or smaller files.',
      };
    }

    let answer: Answer;
    try {
      answer = await this.call(
        credential.apiKey,
        `/accounts/${encodeURIComponent(credential.accountId)}/email/sending/send`,
        { method: 'POST', body: json },
        net,
      );
    } catch {
      // Cloudflare takes no idempotency key: a send whose answer was lost may have landed, and
      // `unknown` is never sent again, so the email goes at most once.
      return { status: 'unknown', remoteMessageIds: [] };
    }
    // A rate limit refuses before sending anything, so the retry cannot send it twice.
    if (answer.status === 429) return { status: 'pending', remoteMessageIds: [] };
    if (answer.status >= 400 && answer.status < 500) {
      return {
        status: 'failed',
        remoteMessageIds: [],
        error: `Cloudflare refused this email (${answer.message}).`,
      };
    }
    if (!answer.ok) return { status: 'unknown', remoteMessageIds: [] };

    // The `Message-ID` Cloudflare assigns is the one a reply names in `In-Reply-To`.
    const sent = z.object({ message_id: z.string().min(1).max(250) }).safeParse(answer.result);
    const messageId = sent.data?.message_id.trim();
    return {
      status: 'sent',
      remoteMessageIds: messageId ? [messageId.startsWith('<') ? messageId : `<${messageId}>`] : [],
    };
  }
}
