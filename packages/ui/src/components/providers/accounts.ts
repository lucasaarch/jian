import type { Provider, ProviderModelList, SubscriptionUsage } from '../../lib/api';
import { date } from '../../lib/format';

export type Credential = 'key' | 'subscription';

/**
 * Which accounts one line of the providers page stands for: a vendor, its ChatGPT sign-ins apart
 * from its keys, and for Anthropic one of its two credentials, each listed as a provider of its
 * own though the gateway keeps one Anthropic account active across both.
 */
export type AccountsOf = { kind: string; codex?: boolean; credential?: Credential };

/** Which of Anthropic's credentials an account is; one from the environment says so too. */
export const credentialOf = (provider: Provider): Credential =>
  provider.credential === 'subscription' || provider.apiKeyEnv === 'ANTHROPIC_API_TOKEN'
    ? 'subscription'
    : 'key';

export function accountsOf(accounts: Provider[], of: AccountsOf): Provider[] {
  return accounts.filter(
    (account) =>
      account.kind === of.kind &&
      !account.revokedAt &&
      (account.authMode === 'codex') === Boolean(of.codex) &&
      (!of.credential || credentialOf(account) === of.credential),
  );
}

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** What an account is called: what the owner named it, or what the gateway numbered it. */
export const accountName = (account: Provider) => account.label ?? 'Account';

/** What a line of the providers page says of its accounts: the one in use, and how many. */
export function accountsSummary(accounts: Provider[]): string | undefined {
  if (accounts.length === 0) return undefined;
  const active = accounts.find((account) => account.active);
  const using = active ? accountName(active) : 'Not in use';

  return accounts.length > 1 ? `${using} · ${count(accounts.length, 'account')}` : using;
}

/** How much of a subscription's windows is used, as a row says it. */
function usageLine(usage: SubscriptionUsage | undefined): string {
  if (usage?.status !== 'available') return '';
  return [
    usage.fiveHour ? `5-hour window ${usage.fiveHour.usedPercent.toFixed(0)}% used` : '',
    usage.weekly ? `weekly ${usage.weekly.usedPercent.toFixed(0)}% used` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** What an account's row says under its name: what it is, its models, its subscription's use. */
export function accountFacts(
  account: Provider,
  list: ProviderModelList | undefined,
  usage: SubscriptionUsage | undefined,
): string {
  const saved = `saved on ${date(account.createdAt)}`;
  const what = account.baseURL
    ? `At ${account.baseURL}`
    : account.authMode === 'codex'
      ? `ChatGPT login ${saved}`
      : account.kind === 'anthropic' && credentialOf(account) === 'subscription'
        ? `Subscription token ${saved}`
        : `API key ${saved}`;

  return [what, list?.models.length ? count(list.models.length, 'model') : '', usageLine(usage)]
    .filter(Boolean)
    .join(' · ');
}
