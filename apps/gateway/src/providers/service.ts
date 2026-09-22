import { randomUUID } from 'node:crypto';
import {
  type ModelConfig,
  type ModelSelection,
  modelDefaultsInputSchema,
  modelDefaultsRecordSchema,
  type ProviderRecord,
  providerInputSchema,
  providerRecordSchema,
  type Run,
} from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { ProfileReader } from '../profiles/port.js';
import { GATEWAY_SCOPE, type GatewayVault } from '../security/gateway-vault.js';
import type { Queryable, Store } from '../storage/database.js';
import { modelCapabilities } from './capabilities.js';
import { environmentProvider, providerKinds } from './catalog.js';
import type { ModelCatalog } from './catalog-source.js';
import { anthropicCredential } from './claude-subscription.js';
import {
  findProvider,
  insertProvider,
  isUniqueViolation,
  listProviders,
  markProviderRevoked,
  readModelDefaults,
  revokeLiveProviders,
  writeModelDefaults,
} from './repository.js';

/** Where a provider's key lives in the vault. Revoking the provider takes the key with it. */
export const providerSecret = (providerId: string) => `provider:${providerId}`;

/** The ceilings a run freezes; the run record keeps them optional for pre-selection runs. */
export type ContextPolicy = NonNullable<Run['contextPolicy']>;

export class Providers {
  constructor(
    private readonly store: Store,
    // Credentials need no profile; the model each profile chooses with them does.
    private readonly profiles: ProfileReader,
    private readonly vault: GatewayVault,
    private readonly clock: Clock = Date.now,
    private readonly catalog?: ModelCatalog,
  ) {}

  async providers() {
    const stored = await listProviders(this.store.db);
    // A configured provider hides the host environment's key for the same vendor.
    const environment = providerKinds
      .map((kind) => environmentProvider(kind))
      .filter((provider) => provider !== null)
      .filter((provider) => !stored.some((item) => !item.revokedAt && item.kind === provider.kind));

    return [...stored, ...environment];
  }

  async createProvider(input: unknown) {
    const { secret, credential, ...data } = providerInputSchema.parse(input);

    return this.register(
      {
        ...data,
        // Only Anthropic has two kinds of credential; for the others the question has one answer.
        ...(data.kind === 'anthropic'
          ? { credential: anthropicCredential(credential, undefined, secret) }
          : {}),
        id: randomUUID(),
        createdAt: nowIso(this.clock),
      },
      secret,
    );
  }

  configureCodexProvider(secret: string) {
    return this.register(
      providerRecordSchema.parse({
        id: randomUUID(),
        name: 'OpenAI',
        kind: 'openai',
        authMode: 'codex',
        createdAt: nowIso(this.clock),
      }),
      secret,
    );
  }

  /**
   * One live provider per vendor: configuring another revokes the old one and its key.
   * Nothing is announced — an installation credential belongs to no profile's event stream,
   * and the row's own timestamps are what says when it arrived and when it went.
   */
  private async register(provider: ProviderRecord, secret: string) {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const now = new Date(this.clock());

      for (const revoked of await revokeLiveProviders(tx, provider.kind, now)) {
        await this.vault.discard(providerSecret(revoked), tx);
      }

      await this.vault.put(providerSecret(provider.id), secret, tx);

      try {
        await insertProvider(tx, provider);
      } catch (error) {
        // The partial unique index has the last word on one live provider per vendor. Reaching
        // it means another request configured this vendor first, which the owner has to see as
        // a conflict rather than as a gateway fault.
        if (isUniqueViolation(error)) {
          throw new GatewayError(
            409,
            'Another provider for this vendor was configured; reload before retrying',
          );
        }

        throw error;
      }

      return provider;
    });
  }

  async revokeProvider(providerId: string) {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const provider = await findProvider(tx, providerId);

      if (!provider) {
        throw new GatewayError(404, 'Provider not found');
      }

      const revoked = { ...provider, revokedAt: provider.revokedAt ?? nowIso(this.clock) };

      await markProviderRevoked(tx, providerId, new Date(revoked.revokedAt));
      await this.vault.discard(providerSecret(providerId), tx);

      return revoked;
    });
  }

  async modelDefaults(profileId: string) {
    await this.profiles.profile(profileId);

    // Assembled from one row per role, so a role that has no row — because it was never set, or
    // because it did not exist when the others were — reads back as empty instead of missing.
    return readModelDefaults(this.store.db, profileId, nowIso(this.clock));
  }

  async setModelDefaults(profileId: string, input: unknown) {
    const data = modelDefaultsInputSchema.parse(input);

    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);

      // Every role is validated, including the ones no runtime executes yet: a selection that
      // cannot resolve today would fail silently the day its runtime lands.
      for (const selection of Object.values(data)) {
        if (selection) {
          await this.selectedModel(selection, tx);
        }
      }

      const updatedAt = nowIso(this.clock);

      await writeModelDefaults(tx, profileId, data, new Date(updatedAt));
      await recordEvent(tx, this.clock, profileId, 'model-defaults.updated', data);

      return modelDefaultsRecordSchema.parse({ ...data, id: profileId, profileId, updatedAt });
    });
  }

  async selectedModel(
    selection: ModelSelection,
    reader: Queryable,
  ): Promise<{ config: ModelConfig; policy: ContextPolicy }> {
    const provider =
      (await findProvider(reader, selection.providerId)) ??
      providerKinds
        .map((kind) => environmentProvider(kind))
        .find((item) => item?.id === selection.providerId);

    if (!provider || provider.revokedAt) {
      throw new GatewayError(409, 'Selected provider or model is unavailable');
    }

    // Which models exist is the provider's answer and can change between two requests, so a
    // selection is never checked against a list: a provider outage would otherwise revoke a
    // model the owner already chose. Only the provider itself has to be live.
    const model = modelCapabilities(
      provider.kind,
      selection.modelId,
      undefined,
      this.catalog?.lookup(provider.kind, selection.modelId),
    );

    // Only a model whose accepted levels are actually known can have a level refused here.
    // For anything uncatalogued the provider is the authority: refusing on our own missing
    // information is how a working model ends up unusable.
    if (
      selection.reasoningEffort &&
      model.reasoningEfforts.length > 0 &&
      !model.reasoningEfforts.includes(selection.reasoningEffort)
    ) {
      throw new GatewayError(409, 'This model does not accept the selected reasoning effort');
    }

    // Ceilings, not targets: a large context window must not inflate routine memory/history.
    return {
      config: {
        provider: provider.authMode === 'codex' ? ('openai-codex' as const) : provider.kind,
        modelId: selection.modelId,
        ...(provider.kind === 'anthropic'
          ? { credential: anthropicCredential(provider.credential, provider.apiKeyEnv, undefined) }
          : {}),
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : { providerId: provider.id }),
      },
      policy: {
        inputTokens: Math.min(32_000, Math.max(4096, Math.floor(model.contextWindow * 0.45))),
        outputTokens: Math.min(4096, model.maxOutputTokens, Math.floor(model.contextWindow * 0.12)),
        memoryTokens: Math.min(1500, Math.floor(model.contextWindow * 0.04)),
        historyTokens: Math.min(6000, Math.floor(model.contextWindow * 0.12)),
        toolResultTokens: Math.min(1500, Math.max(128, Math.floor(model.contextWindow * 0.04))),
        maxSteps: 200,
        maxRunTokens: 500_000,
      },
    };
  }
}
