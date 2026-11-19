import type {
  ModelSelection,
  ProviderRecord,
  ReasoningEffort,
  SubagentTier,
} from '@jian/contracts';
import type { ModelCatalog } from './catalog-source.js';
import type { ProviderModels } from './discovery.js';
import { type Candidate, conversationalModels, newestFirst } from './fallback.js';
import type { ProviderAdmin } from './port.js';

/**
 * Model families named for small, quick work. Whole words only — `gemini` holds a `mini` — and
 * checked before `DEEP`, so a `mini` is never lost to a `max` elsewhere in the name.
 */
const LIGHT = /haiku|\b(?:mini|nano|lite|flash|fast)\b/i;
/** Model families named for the hardest work. `pro` and `max` alone, not inside a word. */
const DEEP = /opus|fable|mythos|\bpro\b|astra|heavy|\bmax\b/i;

/**
 * The tier a model's own name places it in. A family named for neither is the middle one. A name
 * never says `premium`: only a price does.
 */
export function modelTier(model: { id: string; displayName?: string }): NamedTier {
  const name = `${model.id} ${model.displayName ?? ''}`;

  if (LIGHT.test(name)) return 'light';
  if (DEEP.test(name)) return 'deep';
  return 'standard';
}

type NamedTier = Exclude<SubagentTier, 'premium'>;

/**
 * How far above the provider's cheapest deep-named model a deep model's list price has to be,
 * input and output both, to be `premium`. Claude Fable 5.2 is twice Opus 5.5 and is the case
 * this exists for; an older generation at three times a newer one's price (Opus 4.1 beside
 * Opus 4.5) lands there too, and a few percent between two current deep models does not.
 */
const PREMIUM_FACTOR = 1.5;

/**
 * A family the names above do not know is placed by its list price too: priced at least like
 * one of the same provider's deep-named models, it is deep. By name alone a new top family —
 * Claude Fable 5.2, twice Opus 5.5's price — landed in the middle tier and, as its newest
 * model, took every `standard` subagent there.
 *
 * Deep, and priced `PREMIUM_FACTOR` above the cheapest deep-named model of the provider, it is
 * premium, which nothing picks on its own: as the newest deep model, Fable 5.2 took every deep
 * subagent, and six of them spent an owner's whole allowance in one morning. Without a price,
 * its own or that of a deep-named sibling, a model keeps the tier of its name: premium is never
 * a guess.
 */
function tierAmong(model: Candidate, siblings: Candidate[]): SubagentTier {
  const named = modelTier(model);
  const price = model.entry.price;

  if (!price) return named;

  const deepNamed = siblings.flatMap((sibling) =>
    modelTier(sibling) === 'deep' && sibling.entry.price ? [sibling.entry.price] : [],
  );
  const deep =
    named === 'deep' ||
    (named === 'standard' && deepNamed.some((sibling) => price.output >= sibling.output));

  if (!deep) return named;

  const floor = deepNamed.reduce<(typeof deepNamed)[number] | undefined>(
    (cheapest, sibling) => (!cheapest || sibling.output < cheapest.output ? sibling : cheapest),
    undefined,
  );

  return floor &&
    price.output >= floor.output * PREMIUM_FACTOR &&
    price.input >= floor.input * PREMIUM_FACTOR
    ? 'premium'
    : 'deep';
}

/**
 * Which credentials are asked first. A subscription — the ChatGPT login, a Claude subscription
 * token — is paid for already, so work goes there before it spends API credit; Grok comes next,
 * then every other key.
 */
function providerRank(provider: Pick<ProviderRecord, 'kind' | 'authMode' | 'credential'>) {
  if (provider.kind === 'openai' && provider.authMode === 'codex') return 0;
  if (provider.kind === 'anthropic' && provider.credential === 'subscription') return 0;
  if (provider.kind === 'xai') return 1;
  return 2;
}

/** How hard each tier thinks, where its model lets the effort be set at all. */
const EFFORT: Record<SubagentTier, ReasoningEffort> = {
  light: 'low',
  standard: 'medium',
  deep: 'high',
  premium: 'high',
};

/**
 * The model a subagent gets for its tier: from the first provider, in `providerRank` order,
 * that offers a model of that tier, the newest of them. Within a rank the provider the parent
 * runs on goes first, so a conversation stays on its own credential when that one has the tier.
 *
 * Deep never borrows upwards: a premium model is not among its candidates, so where a provider
 * has no other deep model deep goes on to the next one, and with none anywhere the subagent keeps
 * its parent's model. Premium, asked for where no provider has one, is the deep model instead:
 * the agent wanted the most capable model, and deep is the nearest.
 */
export class TierModels {
  constructor(
    private readonly providers: Pick<ProviderAdmin, 'providers'>,
    private readonly models: Pick<ProviderModels, 'list'>,
    private readonly catalog?: ModelCatalog,
  ) {}

  async pick(tier: SubagentTier, parentProviderId?: string): Promise<ModelSelection | null> {
    await this.catalog?.prime().catch(() => undefined);

    const live = (await this.providers.providers())
      .filter((provider) => !provider.revokedAt)
      .map((provider, index) => ({ provider, index }))
      .sort(
        (a, b) =>
          providerRank(a.provider) - providerRank(b.provider) ||
          Number(b.provider.id === parentProviderId) - Number(a.provider.id === parentProviderId) ||
          a.index - b.index,
      );

    for (const { provider } of live) {
      const candidates = await conversationalModels(provider, this.models, this.catalog);
      const best = candidates
        .filter((model) => tierAmong(model, candidates) === tier)
        .sort(newestFirst)[0];

      if (best) return selection(provider, best, tier);
    }

    return tier === 'premium' ? this.pick('deep', parentProviderId) : null;
  }
}

function selection(provider: ProviderRecord, model: Candidate, tier: SubagentTier): ModelSelection {
  const effort = EFFORT[tier];

  return {
    providerId: provider.id,
    modelId: model.id,
    ...(model.reasoningEfforts.includes(effort) ? { reasoningEffort: effort } : {}),
  };
}
