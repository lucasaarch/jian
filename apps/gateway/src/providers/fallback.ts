import type { ModelSelection, ProviderRecord, ReasoningEffort } from '@jian/contracts';
import { bareModelId } from './capabilities.js';
import type { CatalogEntry, ModelCatalog } from './catalog-source.js';
import type { ProviderModels } from './discovery.js';
import type { ProviderAdmin } from './port.js';

/**
 * Picks a model when the owner has not, so a profile answers as soon as a provider exists.
 *
 * A preferred Claude Opus or GPT-6 Astra wins when that provider offers it. Otherwise the
 * public catalog filters out models that cannot take and return text, and the newest compatible
 * model wins. A model the catalog does not know is skipped rather than guessed at.
 */
export class ModelFallback {
  constructor(
    private readonly providers: ProviderAdmin,
    private readonly models: Pick<ProviderModels, 'list'>,
    private readonly catalog?: ModelCatalog,
  ) {}

  async pick(): Promise<ModelSelection | null> {
    // The catalog is what tells a chat model from an embedding one, and on a gateway that has
    // just started it has not been read yet. Waiting for it here is the difference between a
    // first message that answers and one that asks the owner to go and configure something.
    await this.catalog?.prime().catch(() => undefined);

    const live = preferredProviders(await this.providers.providers());
    const available: Array<{ provider: ProviderRecord; models: Candidate[] }> = [];
    const claude = live.filter((provider) => provider.kind === 'anthropic');
    const gpt = live.filter((provider) => provider.kind !== 'anthropic');
    for (const provider of claude) {
      const models = await this.conversational(provider);
      available.push({ provider, models });
      const preferred = models.find((model) =>
        /opus[-_. ]?5[-_. ]?5/i.test(`${model.id} ${model.displayName ?? ''}`),
      );
      if (preferred) return { providerId: provider.id, modelId: preferred.id };
    }
    for (const provider of gpt) {
      const models = await this.conversational(provider);
      available.push({ provider, models });
      const astra = models.find((model) =>
        /gpt-?6[-_. ]?astra/i.test(`${model.id} ${model.displayName ?? ''}`),
      );
      if (astra) return { providerId: provider.id, modelId: astra.id };
    }

    for (const { provider, models } of available.filter(
      (item) => item.provider.kind === 'anthropic',
    )) {
      const opus = models.find((model) => /opus/i.test(`${model.id} ${model.displayName ?? ''}`));
      if (opus) return { providerId: provider.id, modelId: opus.id };
    }

    for (const { provider, models } of available) {
      const best = models.sort(newestFirst)[0];
      if (best) return { providerId: provider.id, modelId: best.id };
    }
    return null;
  }

  private conversational(provider: ProviderRecord): Promise<Candidate[]> {
    return conversationalModels(provider, this.models, this.catalog);
  }
}

const priority = new Map([
  ['anthropic', 0],
  ['openai', 1],
]);

/**
 * The live providers, in the order a choice between them is made: Anthropic, then OpenAI, then
 * the rest as they were connected. Wherever the same model is reachable twice, this decides.
 */
export function preferredProviders(providers: ProviderRecord[]): ProviderRecord[] {
  return providers
    .filter((provider) => !provider.revokedAt)
    .sort((a, b) => (priority.get(a.kind) ?? 2) - (priority.get(b.kind) ?? 2));
}

/** A model that can hold a conversation, with what the catalog knows of it. */
export type Candidate = {
  id: string;
  displayName?: string;
  entry: CatalogEntry;
  /** What the provider reports, else what the catalog does: empty when the model has none. */
  reasoningEfforts: ReasoningEffort[];
};

/**
 * The models of one provider that take and return text. The catalog is what tells a chat model
 * from an embedding or an image one, so a model it does not know is left out, not guessed at.
 */
export async function conversationalModels(
  provider: ProviderRecord,
  models: Pick<ProviderModels, 'list'>,
  catalog?: ModelCatalog,
): Promise<Candidate[]> {
  const listed = await models.list(provider.id).catch(() => null);
  return (listed?.models ?? []).flatMap((model) => {
    const entry = catalog?.lookup(provider.kind, bareModelId(model.id));
    // Both directions have to be text; an image or audio model cannot answer a chat.
    if (!entry?.inputModalities.includes('text') || !entry.outputModalities.includes('text')) {
      return [];
    }
    return [
      {
        id: model.id,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        entry,
        reasoningEfforts: model.reasoningEfforts.length
          ? model.reasoningEfforts
          : entry.reasoningEfforts,
      },
    ];
  });
}

/** Newest first, then the larger context, then by id so the order never wavers. */
export const newestFirst = (a: Candidate, b: Candidate) =>
  (b.entry.releaseDate ?? '').localeCompare(a.entry.releaseDate ?? '') ||
  (b.entry.contextWindow ?? 0) - (a.entry.contextWindow ?? 0) ||
  a.id.localeCompare(b.id);
