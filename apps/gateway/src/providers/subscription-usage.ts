import type { ProviderRecord, SubscriptionUsage } from '@jian/contracts';
import { z } from 'zod';
import type { GatewayVault } from '../security/gateway-vault.js';
import { claudeLimits, limitsKey } from './claude-limits.js';
import { anthropicCredential } from './claude-subscription.js';
import type { CodexLogin } from './codex/login.js';
import { accountHeaders } from './codex/model.js';
import { providerSecret } from './service.js';

const windowSchema = z.object({
  used_percent: z.number().finite().nonnegative().optional(),
  resets_at: z.union([z.string(), z.number()]).nullish(),
  reset_at: z.union([z.string(), z.number()]).nullish(),
});

function windowOf(value: unknown, field: 'used_percent') {
  const parsed = windowSchema.safeParse(value);
  if (!parsed.success) return null;
  const usedPercent = parsed.data[field];
  if (usedPercent === undefined) return null;
  const reset = parsed.data.resets_at ?? parsed.data.reset_at;
  const date =
    reset === undefined || reset === null
      ? null
      : new Date(typeof reset === 'number' ? reset * 1000 : reset);
  return {
    usedPercent,
    resetsAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
  };
}

const unavailable = (provider: 'codex' | 'claude'): SubscriptionUsage => ({
  provider,
  status: 'unavailable',
  fiveHour: null,
  weekly: null,
});

/** Private provider endpoints may change without notice. Never surface their response bodies. */
export class SubscriptionUsageReader {
  private codexLogin?: Pick<CodexLogin, 'accessToken'>;
  private cached?: { until: number; value: SubscriptionUsage[] };
  private pending?: Promise<SubscriptionUsage[]>;

  constructor(
    private readonly providers: { providers(): Promise<ProviderRecord[]> },
    private readonly vault: GatewayVault,
    private readonly fetcher: typeof fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  useCodexLogin(login: Pick<CodexLogin, 'accessToken'>) {
    this.codexLogin = login;
  }

  async read(): Promise<SubscriptionUsage[]> {
    if (this.cached && this.cached.until > this.clock()) return this.cached.value;
    this.pending ??= this.load()
      .then((value) => {
        this.cached = { until: this.clock() + 60_000, value };
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async load(): Promise<SubscriptionUsage[]> {
    const providers = (await this.providers.providers()).filter((provider) => !provider.revokedAt);
    const subscribed: ProviderRecord[] = [];
    for (const provider of providers) {
      if (provider.authMode === 'codex') {
        subscribed.push(provider);
      } else if (provider.kind === 'anthropic') {
        // Saved before the owner was asked which it is: only the credential itself can tell.
        const secret = provider.credential ? undefined : await this.secretOf(provider);
        if (anthropicCredential(provider.credential, provider.apiKeyEnv, secret) === 'subscription')
          subscribed.push(provider);
      }
    }

    return Promise.all(
      subscribed.map(async (provider): Promise<SubscriptionUsage> => {
        if (provider.authMode === 'codex') return this.readCodex(provider);
        // Only what a real answer said: its headers carry the windows. No request is ever made
        // just to learn them, so a gateway that has not run on Claude since it started knows none.
        const seen = claudeLimits(limitsKey(provider.id), this.clock());
        return seen ? { provider: 'claude', status: 'available', ...seen } : unavailable('claude');
      }),
    );
  }

  private secretOf(provider: ProviderRecord): Promise<string | undefined> {
    return provider.apiKeyEnv
      ? Promise.resolve(process.env[provider.apiKeyEnv])
      : this.vault.read(providerSecret(provider.id));
  }

  private async readCodex(provider: ProviderRecord): Promise<SubscriptionUsage> {
    try {
      const token = await this.codexLogin?.accessToken(provider.id);
      if (!token) return unavailable('codex');
      const codexHeaders = accountHeaders(token);
      if (!codexHeaders['ChatGPT-Account-ID']) return unavailable('codex');
      const response = await this.fetcher('https://chatgpt.com/backend-api/wham/usage', {
        headers: {
          authorization: `Bearer ${token}`,
          ...codexHeaders,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return unavailable('codex');
      const body = z.record(z.string(), z.unknown()).safeParse(await response.json());
      if (!body.success) return unavailable('codex');
      const windows = z.object({ primary_window: z.unknown() }).safeParse(body.data.rate_limit);
      if (!windows.success) return unavailable('codex');
      const weekly = windowOf(windows.data.primary_window, 'used_percent');
      return weekly
        ? { provider: 'codex', status: 'available', fiveHour: null, weekly }
        : unavailable('codex');
    } catch {
      return unavailable('codex');
    }
  }
}
