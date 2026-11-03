import { GatewayError } from '../../core/errors.js';

/** An account that needs the owner: its grant is gone, and only connecting again brings it back. */
export const reconnect = (handle: string) =>
  `@${handle} is no longer connected to X. The owner has to connect it again in Settings > Apps > X.`;

/** The words the agent and the owner read: what happened and who can fix it, never a raw body. */
export class XFailure extends GatewayError {}

type XProblem = {
  type?: unknown;
  title?: unknown;
  detail?: unknown;
  reason?: unknown;
  errors?: { message?: unknown; detail?: unknown }[];
};

const said = (body: XProblem): string | undefined => {
  const first = body.errors?.[0];
  const text = body.detail ?? first?.detail ?? first?.message ?? body.title;

  return typeof text === 'string' && text ? text.slice(0, 400) : undefined;
};

const nothingDone = 'Nothing was done.';

/**
 * Turns a refusal from X into clear words. 402 is `credits-depleted`, seen in X's replies though
 * missing from its error reference. 401 is handled before this, by trying a fresh token first.
 */
export function refusal(status: number, body: XProblem, handle: string, reset?: string | null) {
  const kind = `${String(body.type ?? '')} ${String(body.reason ?? '')}`;
  const detail = said(body);

  if (status === 402 || kind.includes('credits-depleted')) {
    return new XFailure(
      402,
      `The X developer app is out of credits or at its spending limit. ${nothingDone} The owner can add credits in the X Developer Console.`,
    );
  }
  if (status === 403 && /client-not-enrolled|client-forbidden/.test(kind)) {
    return new XFailure(
      403,
      `The X developer app is not enrolled for this, or lacks access to it. ${nothingDone} The owner can check the app in the X Developer Console.`,
    );
  }
  if (status === 403 && /unsupported-authentication/.test(kind)) {
    return new XFailure(
      403,
      `X does not accept an account's own sign-in for this operation. ${nothingDone}`,
    );
  }
  if (status === 403) {
    return new XFailure(
      403,
      `X refused @${handle}: ${detail ?? 'not allowed'}. ${nothingDone} If this is about permissions, the X app needs "Read and write and Direct message" in the Developer Console, and the account connecting again after that.`,
    );
  }
  if (status === 404) {
    return new XFailure(404, `X did not find it: ${detail ?? 'no such resource'}.`);
  }
  if (status === 429) {
    const at = reset && Number(reset) ? new Date(Number(reset) * 1000).toISOString() : undefined;

    return new XFailure(
      429,
      `X's rate limit was reached${at ? `, until ${at}` : ''}. ${nothingDone}`,
    );
  }
  if (status >= 500) {
    return new XFailure(
      502,
      `X had a problem answering (${status}). Whether a change went through is unknown: check before trying again.`,
    );
  }

  return new XFailure(400, `X rejected the request: ${detail ?? `status ${status}`}.`);
}

/** No answer at all. A write may have landed, so the agent must look before it repeats it. */
export const unanswered = (acts: boolean) =>
  new XFailure(
    502,
    acts
      ? 'X did not answer, so whether this went through is unknown. Check before trying again.'
      : 'X did not answer. Try again in a moment.',
  );
