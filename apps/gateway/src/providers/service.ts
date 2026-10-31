import { randomUUID } from 'node:crypto';
import {
  type ModelConfig,
  type ModelRole,
  type ModelSelection,
  modelDefaultsInputSchema,
  modelDefaultsRecordSchema,
  type ProviderRecord,
  providerInputSchema,
  providerRecordSchema,
  type Run,
  supportsModelRole,
} from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { GATEWAY_SCOPE, type GatewayVault } from '../security/gateway-vault.js';
import type { Queryable, Store } from '../storage/database.js';
import { modelCapabilities } from './capabilities.js';
import { environmentProvider, GROQ_BASE_URL, providerKinds, XAI_BASE_URL } from './catalog.js';
import type { ModelCatalog } from './catalog-source.js';
import { anthropicCredential } from './claude-subscription.js';
import {
  findProvider,
  insertProvider,
  isUniqueViolation,
  listProviders,
  markProviderRevoked,
  migrateLocalOllamaProvider,
  readModelDefaults,
  revokeLiveProviders,
  writeModelDefaults,
} from './repository.js';
import { takesFast } from './speed.js';

/** Where a provider's key lives in the vault. Revoking the provider takes the key with it. */
export const providerSecret = (providerId: string) => `provider:${providerId}`;

/** True when the owner is keeping a stored choice, including one that no longer passes role checks. */
function sameModelChoice(
  next: ModelSelection | 'disabled' | null,
  previous: ModelSelection | 'disabled' | null | undefined,
): boolean {
  if (next === previous) return true;
  if (!next || !previous || next === 'disabled' || previous === 'disabled') return false;
  return (
    next.providerId === previous.providerId &&
    next.modelId === previous.modelId &&
    next.reasoningEffort === previous.reasoningEffort &&
    Boolean(next.fast) === Boolean(previous.fast) &&
    next.voiceName === previous.voiceName
  );
}

/** The ceilings a run freezes; the run record keeps them optional for pre-selection runs. */
export type ContextPolicy = NonNullable<Run['contextPolicy']>;

export class Providers {
  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly clock: Clock = Date.now,
    private readonly catalog?: ModelCatalog,
  ) {}

  /** Moves a prior Ollama connection from the generic API provider after schema migration. */
  migrateLegacyOllamaConnection(): Promise<void> {
    return migrateLocalOllamaProvider(this.store.db);
  }

  async providers() {
    const stored = await listProviders(this.store.db);
    // A configured provider hides the host environment's key for the same vendor.
    const environment = providerKinds
      .map((kind) => environmentProvider(kind))
      .filter((provider) => provider !== null)
      .filter(
        (provider) =>
          !stored.some(
            (item) => !item.revokedAt && item.kind === provider.kind && item.authMode !== 'codex',
          ),
      );

    return [...stored, ...environment];
  }

  async createProvider(input: unknown) {
    const { secret, credential, baseURL, ...data } = providerInputSchema.parse(input);
    const server = data.kind === 'openai-compatible' || data.kind === 'ollama';

    if (server && !baseURL) {
      throw new GatewayError(
        400,
        data.kind === 'ollama'
          ? 'Give the Ollama server address, such as http://localhost:11434'
          : 'Give the address of the server, such as http://localhost:11434/v1',
      );
    }

    if (!server && !secret) {
      throw new GatewayError(400, 'Paste the API key for this provider');
    }

    return this.register(
      {
        ...data,
        // Only Anthropic has two kinds of credential; for the others the question has one answer.
        ...(data.kind === 'anthropic'
          ? { credential: anthropicCredential(credential, undefined, secret) }
          : {}),
        // An address is the server's alone; every vendor has its own, fixed.
        ...(server && baseURL ? { baseURL: baseURL.replace(/\/+$/, '') } : {}),
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
   * One live credential per vendor and authentication mode. An OpenAI API key and a
   * ChatGPT login coexist; replacing either revokes only its own previous credential.
   * Nothing is announced — an installation credential belongs to no profile's event stream,
   * and the row's own timestamps are what says when it arrived and when it went.
   */
  private async register(provider: ProviderRecord, secret?: string) {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const now = new Date(this.clock());

      for (const revoked of await revokeLiveProviders(
        tx,
        provider.kind,
        now,
        provider.authMode ?? 'api',
      )) {
        await this.vault.discard(providerSecret(revoked), tx);
      }

      if (secret) await this.vault.put(providerSecret(provider.id), secret, tx);

      try {
        await insertProvider(tx, provider);
      } catch (error) {
        // The partial unique index has the last word on one live credential per vendor and mode. Reaching
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

  /**
   * The installation's models, shared by every agent. Assembled from one row per role; missing
   * optional roles start disabled, while a saved null keeps the provider-preferred fallback.
   */
  async modelDefaults() {
    return readModelDefaults(this.store.db, nowIso(this.clock));
  }

  async setModelDefaults(input: unknown) {
    const data = modelDefaultsInputSchema.parse(input);
    // Older clients may still send transcription. Both names now address one audio selection.
    if (data.transcription && (data.audio === null || !Object.hasOwn(input as object, 'audio'))) {
      data.audio = data.transcription;
    }
    data.transcription = data.audio === 'disabled' ? null : data.audio;
    await this.warmCatalog();
    const available = await this.providers();

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const current = await readModelDefaults(tx, nowIso(this.clock));

      // The panel sends every role on each save. A stored choice can fail today's role checks
      // while the owner only wants to change another activity — validate only what actually
      // changed so one stale role cannot block the rest.
      for (const [role, selection] of Object.entries(data)) {
        if (!selection || selection === 'disabled') continue;
        if (sameModelChoice(selection, current[role as ModelRole])) continue;
        const chosen = await this.selectedModel(selection, tx);
        const provider = available.find((item) => item.id === selection.providerId);
        if (
          provider &&
          !supportsModelRole(
            provider,
            { id: selection.modelId, ...this.capabilities(chosen.config) },
            role as ModelRole,
          )
        )
          throw new GatewayError(
            409,
            `This model cannot run ${role}; choose a compatible model and credential`,
          );
      }

      const updatedAt = nowIso(this.clock);

      await writeModelDefaults(tx, data, new Date(updatedAt));

      return modelDefaultsRecordSchema.parse({ ...data, updatedAt });
    });
  }

  async loadCapabilities(config: ModelConfig) {
    await this.catalog?.prime();
    return this.capabilities(config);
  }

  async warmCatalog() {
    await this.catalog?.prime();
  }

  capabilities(config: ModelConfig) {
    const kind =
      config.provider === 'openai-codex'
        ? 'openai'
        : config.provider === 'openai-compatible'
          ? 'openrouter'
          : config.provider;
    return modelCapabilities(
      kind,
      config.modelId,
      undefined,
      this.catalog?.lookup(kind, config.modelId),
    );
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
        // Groq, xAI and a server the owner runs all speak the OpenAI API at their own address.
        ...(provider.kind === 'groq' ||
        provider.kind === 'xai' ||
        provider.kind === 'openai-compatible'
          ? {
              provider: 'openai-compatible' as const,
              baseURL:
                provider.kind === 'groq'
                  ? GROQ_BASE_URL
                  : provider.kind === 'xai'
                    ? XAI_BASE_URL
                    : (provider.baseURL ?? ''),
            }
          : {
              provider: provider.authMode === 'codex' ? ('openai-codex' as const) : provider.kind,
            }),
        modelId: selection.modelId,
        ...(provider.kind === 'anthropic'
          ? { credential: anthropicCredential(provider.credential, provider.apiKeyEnv, undefined) }
          : {}),
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        // Only where the model takes it: a stale choice must not cost a refused request.
        ...(selection.fast && takesFast(provider.kind, selection.modelId) ? { fast: true } : {}),
        ...(provider.kind === 'ollama' ? { baseURL: provider.baseURL } : {}),
        ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : { providerId: provider.id }),
      },
      // Reserve output inside the model's actual window. Session compaction, not a fixed
      // history share, decides when older turns leave the request.
      policy: {
        inputTokens: model.contextWindow,
        outputTokens: Math.min(
          model.maxOutputTokens,
          Math.max(1024, Math.floor(model.contextWindow / 4)),
          model.contextWindow - 256,
        ),
        memoryTokens: Math.min(32_000, Math.max(1500, Math.floor(model.contextWindow * 0.02))),
        historyTokens: model.contextWindow,
        toolResultTokens: Math.min(32_000, Math.max(1500, Math.floor(model.contextWindow * 0.02))),
        maxSteps: 500,
      },
    };
  }
}
