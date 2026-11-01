/**
 * What the owner reads when X sends them back. The gateway names why a connection failed in
 * `?reason=`; the sentence says what to do next.
 */
const failures: Record<string, string> = {
  denied: 'X sign-in was cancelled.',
  expired: 'The X connection took too long or was already used. Connect again.',
  exchange:
    "X did not accept the sign-in. Check the app's client id and secret, and that its callback URL matches the one shown here.",
  scope:
    'X refused a permission Jian asks for. Check that the app has Read and write and Direct message permissions.',
  profile: 'X did not say which account signed in. Try again.',
  gateway: 'Jian could not record the X account. Its log says why.',
};

/** The outcome X left in the address, said once and then dropped from it. */
export function xOutcome(params: URLSearchParams): { text: string; failed: boolean } | undefined {
  const result = params.get('x');

  if (!result) return undefined;
  if (result === 'connected') return { text: 'X account connected.', failed: false };

  return {
    text: failures[params.get('reason') ?? ''] ?? 'X sign-in failed. Try again.',
    failed: true,
  };
}
