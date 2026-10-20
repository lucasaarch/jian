'use client';

import { supportsModelRole, supportsProviderRole } from '@jian/contracts';
import type { ProfileData, Provider } from '../../lib/api';
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

export const providerName = (provider: Provider) =>
  `${provider.name}${provider.kind === 'openai' ? (provider.authMode === 'codex' ? ' · ChatGPT' : ' · API key') : ''}`;

/**
 * Every model of every connected provider that can do this activity, in one list: the owner
 * picks a model, and the provider comes with it. Each one names its provider underneath, so
 * the same model reached through two accounts stays two choices.
 */
export function modelChoices(
  role: Role,
  data: ProfileData,
  configured: Provider[],
): SelectOption[] {
  return configured
    .filter((provider) => supportsProviderRole(provider, role))
    .flatMap((provider) =>
      (data.providerModels[provider.id]?.models ?? [])
        .filter((model) => supportsModelRole(provider, model, role))
        .map((model) => ({
          value: choiceOf(provider.id, model.id),
          // Only the name: an uncatalogued model is flagged once it is chosen, not in the menu.
          label: modelLabel(model, false),
          detail: providerName(provider),
        })),
    );
}

/** What one activity can offer and has chosen, read the same by its card and its dialog. */
export function describeRole(value: RoleValue, data: ProfileData, configured: Provider[]) {
  const provider = configured.find((item) => item.id === value.providerId);
  const list = value.providerId ? data.providerModels[value.providerId] : undefined;
  const selected = (list?.models ?? []).find((model) => model.id === value.modelId);
  const allowed = efforts.filter((effort) => selected?.reasoningEfforts.includes(effort.value));

  return { provider, list, selected, allowed };
}

const geminiLiveVoices = [
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

const gptLiveVoices = [
  'alloy',
  'ash',
  'ballad',
  'beacon',
  'bossa',
  'brise',
  'cedar',
  'cinder',
  'coral',
  'delta',
  'echo',
  'flitz',
  'gleam',
  'harema',
  'juni',
  'marin',
  'meridian',
  'nira',
  'noeul',
  'nuri',
  'quartz',
  'ripple',
  'sage',
  'shimmer',
  'shitan',
  'sillage',
  'stone',
  'tempo',
  'verse',
  'vesper',
  'willow',
];

function voiceOptions(provider: string, speech = false): SelectOption[] {
  const voices = speech
    ? provider === 'google'
      ? geminiLiveVoices
      : provider === 'openai'
        ? ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']
        : []
    : provider === 'google'
      ? geminiLiveVoices
      : provider === 'openai'
        ? gptLiveVoices
        : [];
  return [
    { value: '', label: 'Default voice' },
    ...voices.map((voice) => ({ value: voice, label: voice })),
  ];
}

export function RoleFields({
  role,
  value,
  data,
  configured,
  hasOpenAIKey,
  busy,
  change,
}: {
  role: (typeof roles)[number];
  value: RoleValue;
  data: ProfileData;
  configured: Provider[];
  hasOpenAIKey: boolean;
  busy: boolean;
  change: (role: Role, patch: Partial<RoleValue>) => void;
}) {
  const { provider, list, allowed } = describeRole(value, data, configured);
  const choices = modelChoices(role.key, data, configured);
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

                change(role.key, {
                  providerId: choice.slice(0, split),
                  modelId: choice.slice(split + 1),
                  reasoningEffort: '',
                  voiceName: undefined,
                  disabled: false,
                });
              }
            }}
            options={[
              ...(optionalRoles.has(role.key) ? [{ value: 'disabled', label: 'Disabled' }] : []),
              { value: '', label: 'Automatic' },
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
            <a href="/ui/providers/">Configure an OpenAI API key in Providers.</a> ChatGPT login
            does not authorize image generation.
          </p>
        )}
        {(role.key === 'voice' || role.key === 'speech') &&
          !value.disabled &&
          provider &&
          value.modelId && (
            <Field label="Voice">
              <Select
                value={value.voiceName ?? ''}
                disabled={busy}
                onValueChange={(voiceName) =>
                  change(role.key, { voiceName: voiceName || undefined })
                }
                options={voiceOptions(provider.kind, role.key === 'speech')}
              />
            </Field>
          )}
        {role.tools && !value.disabled && (
          <Field label="Effort">
            <Select
              value={value.reasoningEffort}
              disabled={busy || !allowed.length}
              onValueChange={(reasoningEffort) => change(role.key, { reasoningEffort })}
              options={[{ value: '', label: "The provider's own default" }, ...allowed]}
            />
          </Field>
        )}
      </div>
    </>
  );
}
