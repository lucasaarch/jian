import { randomUUID } from 'node:crypto';
import {
  type ModelConfig,
  type ModelRole,
  type ModelSelection,
  modelDefaultsInputSchema,
  modelDefaultsRecordSchema,
  type ProviderRecord,
  providerAccountPatchSchema,
  providerInputSchema,
  providerRecordSchema,
  type Run,
  supportsModelRole,
} from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { GATEWAY_SCOPE, type GatewayVault } from '../security/gateway-vault.js';
import type { Queryable, Store } from '../storage/database.js';
import {
  activeAccountOf,
  chatgptIdentity,
  deactivate,
  freeLabel,
  listAccounts,
  lockAccounts,
  MAX_ACCOUNTS,
  makeActive,
  renameAccount,
  repointChoices,
  successorOf,
  vendorOf,
} from './accounts.js';
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
  writeModelDefaults,
} from './repository.js';
import { takesFast } from './speed.js';

/** Where a provider's key lives in the vault. Revoking the provider takes the key with it. */
/** Most a turn keeps back for the answer and its thinking, in tokens. */
export const MAX_OUTPUT_RESERVE = 64_000;

/**
 * The share of the window one tool result may take before it is stored and paged, and the most
 * it may take, in the provider's tokens (the estimate times the run's scale, `context/scale.ts`).
 * A result stays in every later step of the turn, so a large window does not earn a larger one.
 */
export const TOOL_RESULT_SHARE = 0.02;
export const TOOL_RESULT_CEILING = 12_000;

/** The same for the memories a turn recalls, in the provider's tokens. */
export const MEMORY_SHARE = 0.02;
export const MEMORY_CEILING = 8_000;

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

  /** Each vendor's active account, and a key from the host for a vendor with none stored. */
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

  /** Every live account of every vendor, the ones runs do not use included; never a key. */
  accounts() {
    return listAccounts(this.store.db);
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

    return this.store.transaction(GATEWAY_SCOPE, (tx) =>
      this.addAccount(
        tx,
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
      ),
    );
  }

  /**
   * A ChatGPT sign-in. Signing in again as an account already here refreshes its tokens and makes
   * it the active one; another account is added beside it, named by its email.
   */
  configureCodexProvider(secret: string) {
    const identity = chatgptIdentity(secret);

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const vendor = { kind: 'openai', authMode: 'codex' } as const;
      if (identity.account) {
        for (const account of await lockAccounts(tx, vendor)) {
          const held = chatgptIdentity(await this.vault.read(providerSecret(account.id), tx));
          if (held.account !== identity.account) continue;
          await this.vault.put(providerSecret(account.id), secret, tx);
          await makeActive(tx, account);
          await repointChoices(tx, account);
          return { ...account, active: true };
        }
      }

      return this.addAccount(
        tx,
        providerRecordSchema.parse({
          id: randomUUID(),
          name: 'OpenAI',
          kind: 'openai',
          authMode: 'codex',
          ...(identity.email ? { label: identity.email } : {}),
          createdAt: nowIso(this.clock),
        }),
        secret,
      );
    });
  }

  /**
   * Adds an account and makes it the one runs use, as connecting a vendor always did: who adds
   * an account means to use it, and switching back is one action. The account before it stays,
   * inactive, with its key. Nothing is announced: an installation credential belongs to no
   * profile's event stream, and the row's own timestamps say when it arrived and when it went.
   */
  private async addAccount(tx: Queryable, provider: ProviderRecord, secret?: string) {
    const vendor = vendorOf(provider);
    const live = await lockAccounts(tx, vendor);
    if (live.length >= MAX_ACCOUNTS) {
      throw new GatewayError(409, `Remove an account first: one provider keeps ${MAX_ACCOUNTS}`);
    }
    // Anthropic's key and Claude Code token are listed apart, so each numbers its own.
    const sameCredential = live.filter(
      (account) => (account.credential ?? 'key') === (provider.credential ?? 'key'),
    );
    const account: ProviderRecord = {
      ...provider,
      label: provider.label ?? freeLabel(sameCredential.map((item) => item.label)),
      active: true,
    };

    if (secret) await this.vault.put(providerSecret(account.id), secret, tx);

    try {
      await deactivate(tx, vendor);
      await insertProvider(tx, account);
    } catch (error) {
      // The index has the last word on one active account per vendor and mode. Reaching it
      // means another request added the vendor's first account meanwhile, with nothing yet to
      // lock, which the owner has to see as a conflict rather than as a gateway fault.
      if (isUniqueViolation(error)) {
        throw new GatewayError(409, 'Another account was added meanwhile; reload before retrying');
      }

      throw error;
    }
    await repointChoices(tx, account);

    return account;
  }

  /** Makes a live account the one runs use, in one step: the vendor is never left with none. */
  async activateAccount(providerId: string) {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const named = await findProvider(tx, providerId);
      if (!named || named.revokedAt) throw new GatewayError(404, 'Provider account not found');
      // Read again under the lock, so a removal that committed meanwhile is seen.
      const account = (await lockAccounts(tx, vendorOf(named))).find(
        (item) => item.id === providerId,
      );
      if (!account) throw new GatewayError(404, 'Provider account not found');

      await makeActive(tx, account);
      await repointChoices(tx, account);

      return { ...account, active: true };
    });
  }

  async renameAccount(providerId: string, input: unknown) {
    const { label } = providerAccountPatchSchema.parse(input);

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const account = await findProvider(tx, providerId);
      if (!account || account.revokedAt) throw new GatewayError(404, 'Provider account not found');
      await renameAccount(tx, providerId, label);

      return { ...account, label };
    });
  }

  /**
   * Removes an account with its key. When it was the active one, the newest account left takes
   * over in the same transaction; when it was the last, the vendor is disconnected.
   */
  async revokeProvider(providerId: string) {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const named = await findProvider(tx, providerId);

      if (!named) {
        throw new GatewayError(404, 'Provider not found');
      }

      // Read again under the lock: a switch that committed meanwhile decides who takes over.
      const provider = named.revokedAt
        ? named
        : ((await lockAccounts(tx, vendorOf(named))).find((item) => item.id === providerId) ??
          named);
      const revoked = {
        ...provider,
        revokedAt: provider.revokedAt ?? nowIso(this.clock),
        active: false,
      };

      await markProviderRevoked(tx, providerId, new Date(revoked.revokedAt));
      await this.vault.discard(providerSecret(providerId), tx);

      const successor = provider.active ? await successorOf(tx, provider) : null;
      if (successor) {
        await makeActive(tx, successor);
        await repointChoices(tx, successor);
      }

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
    // Whichever account the choice was made with, the vendor's active one is what runs use.
    const provider =
      (await activeAccountOf(reader, selection.providerId)) ??
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
        ...accountConfig(provider),
        modelId: selection.modelId,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        // Only where the model takes it: a stale choice must not cost a refused request.
        ...(selection.fast && takesFast(provider.kind, selection.modelId) ? { fast: true } : {}),
      },
      // Reserve output inside the model's actual window. Session compaction, not a fixed
      // history share, decides when older turns leave the request. The reserve stops at 64k:
      // a quarter of a 500k window held 125k back that no answer uses, so the meter read 100%
      // with a quarter of the window still free.
      policy: {
        inputTokens: model.contextWindow,
        outputTokens: Math.min(
          model.maxOutputTokens,
          Math.max(1024, Math.min(MAX_OUTPUT_RESERVE, Math.floor(model.contextWindow / 4))),
          model.contextWindow - 256,
        ),
        memoryTokens: Math.min(
          MEMORY_CEILING,
          Math.max(1500, Math.floor(model.contextWindow * MEMORY_SHARE)),
        ),
        historyTokens: model.contextWindow,
        // Past this a result is stored and paged with read_artifact.
        toolResultTokens: Math.min(
          TOOL_RESULT_CEILING,
          Math.max(1500, Math.floor(model.contextWindow * TOOL_RESULT_SHARE)),
        ),
        maxSteps: 500,
        // Where to compact is the agent's, not the model's: a run puts it back (runs/service.ts).
        compactAt: 'auto',
      },
    };
  }

  /**
   * A frozen model config with the account its vendor has active now. A run freezes its config
   * when it is queued and resolves the account once, as it starts, keeping that key to the end:
   * a switch meanwhile reaches the run, a switch during it waits for the next one, and an
   * account removed while a run waited does not strand it. A config of the host's environment,
   * or of a vendor with no account left, is returned as it was and fails as it always did.
   */
  async activeConfig(config: ModelConfig): Promise<ModelConfig> {
    if (!config.providerId) return config;
    const account = await activeAccountOf(this.store.db, config.providerId);

    return account ? { ...config, ...accountConfig(account) } : config;
  }
}

/** What a model config takes from the account it runs on: where to call, and with what. */
function accountConfig(provider: ProviderRecord) {
  return {
    // Groq, xAI and a server the owner runs all speak the OpenAI API at their own address.
    ...(provider.kind === 'groq' || provider.kind === 'xai' || provider.kind === 'openai-compatible'
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
    ...(provider.kind === 'anthropic'
      ? { credential: anthropicCredential(provider.credential, provider.apiKeyEnv, undefined) }
      : {}),
    ...(provider.kind === 'ollama' ? { baseURL: provider.baseURL } : {}),
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : { providerId: provider.id }),
  };
}
