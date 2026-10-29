/**
 * What the owner reads when GitHub sends them back. The gateway names why a connection failed
 * in `?reason=`; GitHub has installed the App by then, so the sentence says what to do next.
 */
const failures: Record<string, string> = {
  denied: 'GitHub authorization was cancelled.',
  incomplete:
    'GitHub came back without an authorization. Connect the account from Jian, not from GitHub’s settings.',
  expired: 'The GitHub connection took too long or was already used. Connect again.',
  authorization: 'GitHub did not confirm the authorization. Connect again.',
  'not-owner': 'The GitHub account you signed in with cannot manage that installation.',
  github: 'GitHub could not be reached to confirm the installation. Try again.',
  save: 'The GitHub account could not be saved. Try again.',
};

/** The outcome GitHub left in the address, said once and then dropped from it. */
export function githubOutcome(
  params: URLSearchParams,
): { text: string; failed: boolean } | undefined {
  const result = params.get('github');

  if (!result) return undefined;
  if (result === 'connected') return { text: 'GitHub account connected.', failed: false };
  if (result === 'registered') {
    return { text: 'GitHub App registered. Open its details to connect accounts.', failed: false };
  }

  return {
    text: failures[params.get('reason') ?? ''] ?? 'GitHub authorization failed. Try again.',
    failed: true,
  };
}
