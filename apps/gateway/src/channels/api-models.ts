import {
  type ModelSelection,
  type ProviderModel,
  type ProviderRecord,
  type ReasoningEffort,
  supportsModelRole,
  supportsProviderRole,
} from '@jian/contracts';
import { GatewayError } from '../core/errors.js';
import type { ProviderModels } from '../providers/discovery.js';
import { preferredProviders } from '../providers/fallback.js';
import type { ProviderAdmin } from '../providers/port.js';

export type ApiModel = { provider: ProviderRecord; model: ProviderModel };

/**
 * Whether a model takes this effort. An uncatalogued model with no levels has a floor the
 * gateway guessed rather than the provider's word, so the provider is left to decide.
 */
function offers(model: ProviderModel, effort: ReasoningEffort): boolean {
  if (!model.known && model.reasoningEfforts.length === 0) return true;

  return model.reasoningEfforts.includes(effort);
}

/**
 * The models an API channel's caller may name by id alone: every conversational model the
 * installation's providers list. A caller outside Jian knows a model's name, not which of the
 * owner's accounts serves it, so an id two providers offer goes to the one the gateway prefers.
 */
export class ApiModels {
  constructor(
    private readonly providers: Pick<ProviderAdmin, 'providers'>,
    private readonly models: Pick<ProviderModels, 'list'>,
  ) {}

  /** In preference order. A provider that cannot be reached adds nothing rather than failing. */
  async available(): Promise<ApiModel[]> {
    const live = preferredProviders(await this.providers.providers()).filter((provider) =>
      supportsProviderRole(provider, 'conversation'),
    );
    const lists = await Promise.all(
      live.map((provider) => this.models.list(provider.id).catch(() => null)),
    );

    return live.flatMap((provider, index) =>
      (lists[index]?.models ?? [])
        .filter((model) => supportsModelRole(provider, model, 'conversation'))
        .map((model) => ({ provider, model })),
    );
  }

  /** The selection a model id stands for, with the effort checked against what it offers. */
  async select(id: string, effort?: ReasoningEffort): Promise<ModelSelection> {
    const found = (await this.available()).find((item) => item.model.id === id);

    if (!found) throw new GatewayError(400, `Unknown model ${id}`);

    return this.withEffort(
      { providerId: found.provider.id, modelId: found.model.id },
      effort,
      found.model,
    );
  }

  /**
   * `selection` at this effort. A model no provider lists right now keeps the effort: the run
   * that uses it checks the effort again against the capability table.
   */
  async withEffort(
    selection: ModelSelection,
    effort: ReasoningEffort | undefined,
    known?: ProviderModel,
  ): Promise<ModelSelection> {
    if (!effort) return selection;

    const model =
      known ??
      (await this.available()).find(
        (item) => item.provider.id === selection.providerId && item.model.id === selection.modelId,
      )?.model;

    if (model && !offers(model, effort)) {
      throw new GatewayError(
        400,
        `Model ${selection.modelId} does not offer the reasoning effort ${effort}`,
      );
    }

    return { ...selection, reasoningEffort: effort };
  }
}
