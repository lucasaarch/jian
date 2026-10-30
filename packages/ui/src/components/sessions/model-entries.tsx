import type { ModelCatalog, ModelSelection, Provider } from '../../lib/api';
import type { Role } from '../providers/catalog';
import { choiceOf, modelChoices } from '../providers/role-choices';
import { ProviderLogo } from '../ui';
import type { ModelEntry } from './model-menu';

/**
 * Every model an activity can run on, as the model menu lists them — each with its provider's
 * mark and name, its efforts and whether it has Fast — the composer's and the settings' alike.
 * One still chosen that no provider offers any more stays listed, marked, so the menu never
 * hides the current choice.
 */
export function modelEntries(
  role: Role,
  catalog: ModelCatalog,
  providers: Provider[],
  chosen?: ModelSelection,
): ModelEntry[] {
  const choices = modelChoices(role, catalog, providers);
  const current = chosen ? choiceOf(chosen.providerId, chosen.modelId) : '';

  return [
    ...choices.map((choice) => {
      const split = choice.value.indexOf(':');
      const providerId = choice.value.slice(0, split);
      const modelId = choice.value.slice(split + 1);
      const offered = catalog.providerModels[providerId]?.models.find(
        (item) => item.id === modelId,
      );
      const provider = providers.find((item) => item.id === providerId);

      return {
        providerId,
        modelId,
        name: choice.label,
        provider: provider ? (provider.name ?? provider.kind) : '',
        ...(provider ? { icon: <ProviderLogo kind={provider.kind} size={16} /> } : {}),
        efforts: offered?.reasoningEfforts ?? [],
        fast: Boolean(offered?.fast),
      };
    }),
    ...(chosen && current && !choices.some((choice) => choice.value === current)
      ? [
          {
            providerId: chosen.providerId,
            modelId: chosen.modelId,
            name: chosen.modelId,
            provider: '',
            efforts: [],
            fast: false,
            gone: true,
          },
        ]
      : []),
  ];
}
