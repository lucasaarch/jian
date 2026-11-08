import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { type InlineMedia, MAX_MEDIA_BYTES, mediaMimeOf } from '@jian/contracts';
import PostalMime, { type Address, addressParser, type Mailbox } from 'postal-mime';
import { GatewayError } from '../../core/errors.js';
import {
  FILE_NOTE,
  MAX_FILES,
  type MailAuthentication,
  MORE_FILES_NOTE,
  type ReceivedEmail,
  type WebhookHeaders,
} from './provider.js';
import { bareAddress } from './text.js';

/** How far a signed timestamp may be from now, in seconds: a replayed message is refused. */
const TOLERANCE_S = 5 * 60;
/**
 * The only authentication service whose verdict counts: Email Routing's own. Cloudflare documents
 * that it validates DMARC and prepends this header before invoking a Worker, and rejects mail that
 * fails both SPF and DKIM or fails a sender's enforcing DMARC policy. The check below trusts that
 * promise: were the header ever missing, a sender's own copy at the top would be read as it.
 */
const AUTHSERV = 'mx.cloudflare.net';
/** As much of Cloudflare's verdict as the Worker forwards; a longer one fails to compare. */
const AUTH_CHARS = 4000;

/**
 * The Email Worker the gateway uploads for a Cloudflare channel. It only forwards: it reads the
 * raw message, signs it with the channel's secret, and posts it to the channel's webhook. It
 * also forwards the `Authentication-Results` Email Routing put first, as `message.headers`
 * reads it, so the gateway can tell that the first such header in the raw bytes is Cloudflare's
 * and not one the sender wrote. A refusal (4xx) rejects the message, so the sender hears of it;
 * anything else is tried three times, then thrown, leaving the retry to Cloudflare.
 */
export const WORKER_SOURCE = `const encoder = new TextEncoder();
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  async email(message, env) {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const recipient = String(message.to).toLowerCase();
    const authentication = (message.headers.get('authentication-results') || '')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, ${AUTH_CHARS});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const prefix = encoder.encode(timestamp + '\\n' + recipient + '\\n' + authentication + '\\n');
    const signed = new Uint8Array(prefix.length + raw.length);
    signed.set(prefix);
    signed.set(raw, prefix.length);
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.JIAN_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = hex(await crypto.subtle.sign('HMAC', key, signed));
    let failure = 'unreachable';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await wait(1000 * attempt);
      try {
        const response = await fetch(env.JIAN_ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'message/rfc822',
            'x-jian-timestamp': timestamp,
            'x-jian-recipient': recipient,
            'x-jian-authentication': authentication,
            'x-jian-signature': 'v1=' + signature,
          },
          body: raw,
        });
        if (response.ok) return;
        if (response.status < 500) {
          message.setReject('The recipient could not take this message (' + response.status + ')');
          return;
        }
        failure = 'HTTP ' + response.status;
      } catch (error) {
        failure = String(error);
      }
    }
    throw new Error('Jian did not take the message: ' + failure);
  },
};
`;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Whitespace as the Worker leaves it, so its copy and the raw header compare equal. */
const squeezed = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * Whether a message was posted by this channel's Worker: `v1=<hex HMAC-SHA256>` keyed with the
 * secret, over `<timestamp>\n<recipient>\n<authentication>\n` and the raw bytes. The fields go
 * first, a line each and never holding a line break, so no two requests sign the same bytes;
 * the timestamp keeps a captured request from being replayed after five minutes, and the
 * request key keeps one replayed sooner from starting a second run.
 */
export function workerSigned(
  raw: Buffer,
  headers: WebhookHeaders,
  secret: string,
  now: number = Date.now(),
): boolean {
  const timestamp = one(headers['x-jian-timestamp']);
  const recipient = one(headers['x-jian-recipient']);
  const authentication = one(headers['x-jian-authentication']) ?? '';
  const signature = one(headers['x-jian-signature'])?.match(/^v1=([0-9a-f]{64})$/)?.[1];

  if (!timestamp || !recipient || !signature || !secret) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_S) return false;
  if (recipient.length > 320 || /[\s]/.test(recipient)) return false;
  if (authentication.length > AUTH_CHARS || /[\r\n]/.test(authentication)) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}\n${recipient}\n${authentication}\n`)
    .update(raw)
    .digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A header value without its RFC 5322 comments, which may say anything, `pass` included. */
function uncommented(value: string) {
  let text = value;
  for (let depth = 0; depth < 5 && /\([^()]*\)/.test(text); depth++)
    text = text.replace(/\([^()]*\)/g, ' ');
  return text;
}

/** Whether `domain` is `from`, or a domain `from` sits under: relaxed DKIM alignment. */
const aligned = (domain: string | undefined, from: string) =>
  !!domain && (from === domain || from.endsWith(`.${domain}`));

/**
 * Cloudflare's verdict on a message, from the first `Authentication-Results` header only, and
 * only when Email Routing wrote it: the Worker's copy of the header must begin with it, and its
 * service must be `mx.cloudflare.net`. A header further down is the sender's, worth nothing.
 * DKIM counts as `pass` only for a signature of the `From` domain or a parent of it, the same
 * guarantee Resend's `dkim` result gives; a DMARC verdict for another domain is not a pass.
 */
export function cloudflareAuthentication(
  first: string | undefined,
  forwarded: string,
  from: string | undefined,
): MailAuthentication {
  if (!first || !from) return null;
  const header = squeezed(first);
  if (!(forwarded === header || forwarded.startsWith(`${header}, `))) return null;

  const [service, ...results] = uncommented(header).split(';');
  if (service?.trim().split(/\s+/)[0]?.toLowerCase() !== AUTHSERV) return null;

  const domain = from.slice(from.lastIndexOf('@') + 1);
  const verdict: Record<'spf' | 'dkim' | 'dmarc', string | undefined> = {
    spf: undefined,
    dkim: undefined,
    dmarc: undefined,
  };
  for (const result of results) {
    const [method, ...properties] = result.trim().split(/\s+/);
    const [name, value] = (method ?? '').toLowerCase().split('=');
    if (!value || !(name === 'spf' || name === 'dkim' || name === 'dmarc')) continue;
    const property = (key: string) =>
      properties
        .find((item) => item.toLowerCase().startsWith(`${key}=`))
        ?.slice(key.length + 1)
        .toLowerCase();
    if (name === 'spf') verdict.spf ??= value.slice(0, 40);
    if (name === 'dkim' && verdict.dkim !== 'pass') {
      verdict.dkim =
        value !== 'pass'
          ? value.slice(0, 40)
          : aligned(property('header.d'), domain)
            ? 'pass'
            : 'unaligned';
    }
    if (name === 'dmarc' && verdict.dmarc === undefined) {
      const named = property('header.from');
      verdict.dmarc =
        value === 'pass' && named && named !== domain ? 'unaligned' : value.slice(0, 40);
    }
  }
  return Object.fromEntries(Object.entries(verdict).filter(([, value]) => value)) as {
    spf?: string;
    dkim?: string;
    dmarc?: string;
  };
}

const mailboxes = (list: Address[] | undefined): Mailbox[] =>
  (list ?? []).flatMap((item) => (item.group ? item.group : [item]));

const addresses = (list: Address[] | undefined) =>
  mailboxes(list)
    .map((item) => bareAddress(item.address))
    .filter((item): item is string => !!item)
    .slice(0, 100);

/** The files of a message, as the gateway keeps them; one too large or empty is a note. */
function filesOf(attachments: Awaited<ReturnType<typeof PostalMime.parse>>['attachments']) {
  const media: InlineMedia[] = [];
  let failed = false;
  for (const file of attachments.slice(0, MAX_FILES)) {
    const bytes =
      typeof file.content === 'string'
        ? Buffer.from(file.content, 'base64')
        : Buffer.from(
            file.content instanceof ArrayBuffer ? new Uint8Array(file.content) : file.content,
          );
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) {
      failed = true;
      continue;
    }
    const name = file.filename?.trim().slice(0, 200) || undefined;
    media.push({
      mimeType: mediaMimeOf(file.mimeType, name),
      data: bytes.toString('base64'),
      ...(name ? { name } : {}),
    });
  }
  const notes = [
    ...(failed ? [FILE_NOTE] : []),
    ...(attachments.length > MAX_FILES ? [MORE_FILES_NOTE] : []),
  ];
  return {
    ...(media.length ? { media } : {}),
    ...(notes.length ? { note: notes.join('\n') } : {}),
  };
}

/**
 * A message the Worker posted, read whole: there is no API to fetch it later. Its id is the
 * sender's `Message-ID` under its address, so a message Cloudflare delivers twice — with other
 * headers prepended each time — is still one request key; a message without one is named by
 * its bytes. HTML is kept as text for the inbox to read, never rendered.
 */
export async function receivedMail(raw: Buffer, headers: WebhookHeaders): Promise<ReceivedEmail> {
  let mail: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    mail = await PostalMime.parse(raw, { maxNestingDepth: 50, maxHeadersSize: 512 * 1024 });
  } catch {
    throw new GatewayError(400, 'Invalid email message');
  }

  const kept: Record<string, string> = {};
  for (const header of mail.headers) {
    if (!(header.key in kept)) kept[header.key] = header.value.slice(0, 4000);
  }
  // Two `From` headers, or two mailboxes in one, name two senders. Neither is trusted, and the
  // message stays anonymous: DMARC vouches for one domain only.
  const froms = mail.headers.filter((header) => header.key === 'from');
  const sender =
    froms.length === 1 ? mailboxes(addressParser(froms[0]?.value ?? '', { flatten: true })) : [];
  const from = sender.length === 1 ? bareAddress(sender[0]?.address) : undefined;
  const name = sender[0]?.name.replace(/["\\\r\n\t<>]/g, '').trim();
  if (from) kept.from = name ? `"${name}" <${from}>` : from;
  else delete kept.from;

  const first = mail.headers.find((header) => header.key === 'authentication-results')?.value;
  const forwarded = one(headers['x-jian-authentication']) ?? '';
  const recipient = (one(headers['x-jian-recipient']) ?? '').toLowerCase();
  const messageId = mail.messageId?.trim().match(/^<[^<>\s]{1,250}>$/)?.[0];
  const id = createHash('sha256')
    .update(messageId && from ? `${from}\n${messageId}` : raw)
    .digest('hex');

  return {
    id,
    from: from ?? '',
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    receivedFor: recipient ? [recipient] : [],
    subject: mail.subject ?? '',
    text: mail.text ?? null,
    html: mail.html ?? null,
    headers: kept,
    ...(messageId ? { messageId } : {}),
    authentication: cloudflareAuthentication(first, forwarded, from),
    attachments: mail.attachments.length,
    ...(mail.attachments.length ? { files: filesOf(mail.attachments) } : {}),
  };
}
