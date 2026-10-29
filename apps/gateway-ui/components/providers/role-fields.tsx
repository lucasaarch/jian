'use client';

import { supportsModelRole, supportsProviderRole } from '@jian/contracts';
import Link from 'next/link';
import { useAgentPath } from '@/lib/workspace';
import type { ModelCatalog, ModelSelection, Provider, ProviderModel } from '../../lib/api';
import { Field } from '../ui';
import { Select, type SelectOption } from '../ui/select';
import { efforts, modelLabel, optionalRoles, type Role, type roles } from './catalog';

export type RoleValue = {
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  voiceName?: string;
  disabled: boolean;
};

/** A provider id is a UUID, so the first colon is always where the model id begins. */
export const choiceOf = (providerId: string, modelId: string) =>
  providerId && modelId ? `${providerId}:${modelId}` : '';

const claudeSubscriptionModels = new Set([
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-fable-5-1',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-haiku-5',
  'claude-haiku-5-5',
]);

const codexModels = new Set([
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6.1-terra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);

/** Keep subscription pickers aligned with the model choices their native CLIs expose. */
function isSelectableModel(provider: Provider, model: ProviderModel) {
  const id = model.id.toLowerCase().replace(/-\d{8}$/, '');
  if (provider.authMode === 'codex') return codexModels.has(id);
  if (provider.kind === 'anthropic' && provider.credential === 'subscription') {
    return claudeSubscriptionModels.has(id);
  }
  return true;
}

const providerName = (provider: Provider) =>
  `${provider.name}${provider.kind === 'openai' ? (provider.authMode === 'codex' ? ' · ChatGPT' : ' · API key') : ''}`;

/**
 * Every model of every connected provider that can do this activity, in one list: the owner
 * picks a model, and the provider comes with it. Each one names its provider underneath, so
 * the same model reached through two accounts stays two choices.
 */
export function modelChoices(
  role: Role,
  catalog: ModelCatalog,
  configured: Provider[],
): SelectOption[] {
  return configured
    .filter((provider) => supportsProviderRole(provider, role))
    .flatMap((provider) =>
      (catalog.providerModels[provider.id]?.models ?? [])
        .filter(
          (model) => isSelectableModel(provider, model) && supportsModelRole(provider, model, role),
        )
        .map((model) => ({
          value: choiceOf(provider.id, model.id),
          // Only the name: an uncatalogued model is flagged once it is chosen, not in the menu.
          label: modelLabel(model, false),
          detail: providerName(provider),
        })),
    );
}

/** New conversation model choices start at Low when that model exposes reasoning levels. */
export function withDefaultEffort(
  selection: ModelSelection | undefined,
  catalog: ModelCatalog,
): ModelSelection | undefined {
  if (!selection || selection.reasoningEffort) return selection;
  const efforts = catalog.providerModels[selection.providerId]?.models.find(
    (model) => model.id === selection.modelId,
  )?.reasoningEfforts;
  const effort = efforts?.includes('low') ? 'low' : efforts?.[0];
  return effort ? { ...selection, reasoningEffort: effort } : selection;
}

/** The chat default follows a configured Anthropic Opus, then GPT-6 Astra, then a live model. */
export function preferredModelSelection(
  role: Role,
  catalog: ModelCatalog,
  configured: Provider[],
): ModelSelection | undefined {
  const choices = modelChoices(role, catalog, configured);
  const byProvider = (provider: Provider | undefined) =>
    provider ? choices.filter((choice) => choice.value.startsWith(`${provider.id}:`)) : [];
  const anthropic = configured.filter((provider) => provider.kind === 'anthropic');
  const openai = configured.filter((provider) => provider.kind === 'openai');
  const other = configured.filter(
    (provider) => provider.kind !== 'anthropic' && provider.kind !== 'openai',
  );
  const anthropicChoices = anthropic.flatMap(byProvider);
  const openaiChoices = openai.flatMap(byProvider);
  const otherChoices = other.flatMap(byProvider);
  const gptChoices = [...openaiChoices, ...otherChoices];
  const ordered = [
    anthropicChoices.find((model) => /opus[-_. ]?5[-_. ]?5/i.test(`${model.value} ${model.label}`)),
    gptChoices.find((model) => /gpt-?6[-_. ]?astra/i.test(`${model.value} ${model.label}`)),
    anthropicChoices.find((model) =>
      /opus[-_. ]?5(?:[-_.]|$)/i.test(`${model.value} ${model.label}`),
    ),
    anthropicChoices.find((model) => /opus/i.test(`${model.value} ${model.label}`)),
    anthropicChoices[0],
    openaiChoices[0],
    otherChoices[0],
  ];
  const choice = ordered.find((model): model is SelectOption => Boolean(model));
  if (!choice) return undefined;
  const separator = choice.value.indexOf(':');
  return withDefaultEffort(
    {
      providerId: choice.value.slice(0, separator),
      modelId: choice.value.slice(separator + 1),
    },
    catalog,
  );
}

/** What one activity can offer and has chosen, read the same by its card and its dialog. */
function describeRole(value: RoleValue, catalog: ModelCatalog, configured: Provider[]) {
  const provider = configured.find((item) => item.id === value.providerId);
  const list = value.providerId ? catalog.providerModels[value.providerId] : undefined;
  const selected = (list?.models ?? []).find((model) => model.id === value.modelId);
  const allowed = efforts.filter((effort) => selected?.reasoningEfforts.includes(effort.value));

  return { provider, list, selected, allowed };
}

const geminiSpeechVoices = [
  'Achernar',
  'Achird',
  'Algenib',
  'Algieba',
  'Alnilam',
  'Aoede',
  'Autonoe',
  'Callirrhoe',
  'Charon',
  'Despina',
  'Enceladus',
  'Erinome',
  'Fenrir',
  'Gacrux',
  'Iapetus',
  'Kore',
  'Laomedeia',
  'Leda',
  'Orus',
  'Puck',
  'Pulcherrima',
  'Rasalgethi',
  'Sadachbia',
  'Sadaltager',
  'Schedar',
  'Sulafat',
  'Umbriel',
  'Vindemiatrix',
  'Zephyr',
  'Zubenelgenubi',
];

function voiceOptions(provider: string): SelectOption[] {
  const voices =
    provider === 'google'
      ? geminiSpeechVoices
      : provider === 'openai'
        ? ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']
        : [];
  return [
    { value: '', label: 'Default voice' },
    ...voices.map((voice) => ({ value: voice, label: voice })),
  ];
}

export function RoleFields({
  role,
  value,
  catalog,
  configured,
  hasOpenAIKey,
  busy,
  change,
}: {
  role: (typeof roles)[number];
  value: RoleValue;
  catalog: ModelCatalog;
  configured: Provider[];
  hasOpenAIKey: boolean;
  busy: boolean;
  change: (role: Role, patch: Partial<RoleValue>) => void;
}) {
  const pathTo = useAgentPath();
  const { provider, list, allowed } = describeRole(value, catalog, configured);
  const choices = modelChoices(role.key, catalog, configured);
  const current = value.disabled ? 'disabled' : choiceOf(value.providerId, value.modelId);

  return (
    <>
      {list?.stale && (
        <p className="note" role="status">
          The list is stale: the provider did not answer the last read.
        </p>
      )}
      <div className="settings-fields">
        <Field label="Model">
          <Select
            value={current}
            disabled={busy}
            onValueChange={(choice) => {
              if (choice === 'disabled') {
                change(role.key, {
                  providerId: '',
                  modelId: '',
                  reasoningEffort: '',
                  disabled: true,
                });
              } else if (!choice) {
                change(role.key, {
                  providerId: '',
                  modelId: '',
                  reasoningEffort: '',
                  disabled: false,
                });
              } else {
                const split = choice.indexOf(':');
                const selection = withDefaultEffort(
                  { providerId: choice.slice(0, split), modelId: choice.slice(split + 1) },
                  catalog,
                );

                change(role.key, {
                  providerId: selection?.providerId ?? '',
                  modelId: selection?.modelId ?? '',
                  reasoningEffort: selection?.reasoningEffort ?? '',
                  voiceName: undefined,
                  disabled: false,
                });
              }
            }}
            options={[
              ...(optionalRoles.has(role.key) ? [{ value: 'disabled', label: 'Disabled' }] : []),
              ...(choices.length
                ? []
                : [{ value: '', label: 'No compatible model available', disabled: true }]),
              ...choices,
              ...(current && !choices.some((choice) => choice.value === current)
                ? [
                    {
                      value: current,
                      label: value.modelId,
                      detail: provider
                        ? `${providerName(provider)} · not offered for this activity`
                        : 'Saved provider, no longer connected',
                    },
                  ]
                : []),
            ]}
          />
        </Field>
        {role.key === 'image' && !value.disabled && !hasOpenAIKey && (
          <p className="note">
            <Link href={pathTo('providers')}>Configure an OpenAI API key in Providers.</Link>{' '}
            ChatGPT login does not authorize image generation.
          </p>
        )}
        {role.key === 'speech' && !value.disabled && provider && value.modelId && (
          <Field label="Voice">
            <Select
              value={value.voiceName ?? ''}
              disabled={busy}
              onValueChange={(voiceName) => change(role.key, { voiceName: voiceName || undefined })}
              options={voiceOptions(provider.kind)}
            />
          </Field>
        )}
        {role.tools && !value.disabled && (
          <Field label="Effort">
            <Select
              value={value.reasoningEffort}
              disabled={busy || !allowed.length}
              onValueChange={(reasoningEffort) => change(role.key, { reasoningEffort })}
              placeholder="Effort"
              options={allowed}
            />
          </Field>
        )}
      </div>
    </>
  );
}
