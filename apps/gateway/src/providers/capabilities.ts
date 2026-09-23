import type { ModelCapabilities } from '@jian/contracts';
import type { ProviderKind } from './catalog.js';
import type { CatalogEntry } from './catalog-source.js';

/**
 * What the gateway assumes when nothing could be learned about a model. It is a floor, not a
 * claim: large enough that a run with a system prompt and a tool list still starts, and the
 * model is marked uncatalogued so the panel says so. Being wrong here costs one clear error
 * from the provider; being too small costs a run that can never start.
 */
const floor = {
  contextWindow: 128_000,
  maxOutputTokens: 8192,
  reasoningEfforts: [] as ModelCapabilities['reasoningEfforts'],
  inputModalities: ['text'] as ModelCapabilities['inputModalities'],
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.floor(value)));

/** Gemini publishes `models/<id>`; every selection and lookup uses the bare id. */
export const bareModelId = (id: string) => id.replace(/^models\//, '');

/** What the provider's own listing said about this model, where it says anything at all. */
export type ReportedCapabilities = {
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: ModelCapabilities['reasoningEfforts'];
  inputModalities?: ModelCapabilities['inputModalities'];
};

/**
 * Resolves in the order of how much each source knows: the provider's own listing first,
 * because it speaks for the account; then the public catalog, which is the only source that
 * carries modalities and reasoning levels for every vendor; then the floor.
 *
 * Nothing here is a per-model table. A model released today resolves today, without a release
 * of this gateway, and a model no source knows stays selectable and is marked uncatalogued.
 */
export function modelCapabilities(
  _kind: ProviderKind,
  _modelId: string,
  reported?: ReportedCapabilities,
  catalogued?: CatalogEntry,
): ModelCapabilities {
  const contextWindow = reported?.contextWindow ?? catalogued?.contextWindow;
  const maxOutputTokens = reported?.maxOutputTokens ?? catalogued?.maxOutputTokens;
  const reasoningEfforts = reported?.reasoningEfforts?.length
    ? reported.reasoningEfforts
    : (catalogued?.reasoningEfforts ?? []);
  const inputModalities = reported?.inputModalities?.length
    ? reported.inputModalities
    : catalogued?.inputModalities?.length
      ? catalogued.inputModalities
      : undefined;

  return {
    contextWindow: contextWindow ? clamp(contextWindow, 4096, 20_000_000) : floor.contextWindow,
    maxOutputTokens: maxOutputTokens
      ? clamp(maxOutputTokens, 256, 1_000_000)
      : floor.maxOutputTokens,
    reasoningEfforts,
    inputModalities: inputModalities ?? floor.inputModalities,
    outputModalities: catalogued?.outputModalities ?? [],
    // Known means a source spoke for this model, not that every field came from one.
    known: Boolean(contextWindow && inputModalities),
  };
}
