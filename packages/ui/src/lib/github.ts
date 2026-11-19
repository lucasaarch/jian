/**
 * What the owner reads when GitHub sends them back. The gateway names why a connection failed
 * in `?reason=`; GitHub may have installed the App by then, so the sentence says what to do next.
 */
const failures: Record<string, string> = {
  denied: 'GitHub authorization was cancelled.',
  incomplete: 'GitHub came back without an authorization. Connect again from Jian.',
  expired: 'The GitHub connection took too long or was already used. Connect again.',
  authorization: 'GitHub did not confirm the authorization. Connect again.',
  'not-owner': 'The GitHub account you signed in with cannot manage that installation.',
  none: 'No installation of Jian’s GitHub App is reachable with that GitHub account yet. If an owner still has to approve it, wait for the approval.',
  github: 'GitHub could not be reached to confirm the installation. Try again.',
  save: 'The GitHub account could not be saved. Try again.',
  gateway: 'Jian could not record the GitHub account. Its log says why.',
};

const REQUESTED =
  'Your request to install Jian’s GitHub App was sent to the organization’s owners.';

/** The outcome GitHub left in the address, said once and then dropped from it. */
export function githubOutcome(
  params: URLSearchParams,
): { text: string; failed: boolean } | undefined {
  const result = params.get('github');

  if (!result) return undefined;
  if (result === 'connected') return { text: 'GitHub account connected.', failed: false };
  if (result === 'registered') {
    return { text: 'GitHub App registered. Now connect an account.', failed: false };
  }
  // A member who is not an owner of the organization asked its owners for the App. `manual`
  // says Jian could not tell who asked, so the approval cannot connect by itself.
  if (result === 'requested') {
    return {
      text:
        params.get('reason') === 'manual'
          ? `${REQUESTED} Once one approves it, connect it here with Connect an approved installation.`
          : `${REQUESTED} Once one approves it, the account connects here by itself.`,
      failed: false,
    };
  }

  return {
    text: failures[params.get('reason') ?? ''] ?? 'GitHub authorization failed. Try again.',
    failed: true,
  };
}
