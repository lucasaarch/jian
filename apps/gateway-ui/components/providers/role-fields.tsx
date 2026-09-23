'use client';

import { supportsModelRole, supportsProviderRole } from '@jian/contracts';
import type { ProfileData, Provider } from '../../lib/api';
import { Badge, Field } from '../ui';
import { Select } from '../ui/select';
import { efforts, modelLabel, type Role, type roles } from './catalog';

export type RoleValue = {
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  /** The id was typed instead of picked, so the panel knows nothing about its capabilities. */
  manual: boolean;
};

/** What one activity can offer and has chosen, read the same by its card and its dialog. */
export function describeRole(
  role: (typeof roles)[number],
  value: RoleValue,
  data: ProfileData,
  configured: Provider[],
) {
  const eligible = configured.filter((provider) => supportsProviderRole(provider, role.key));
  const provider = configured.find((item) => item.id === value.providerId);
  const models = (data.providerModels[value.providerId]?.models ?? []).filter(
    (model) => !provider || supportsModelRole(provider, model, role.key),
  );
  const list = value.providerId ? data.providerModels[value.providerId] : undefined;
  const selected = models.find((model) => model.id === value.modelId);
  // A typed id has no capability row here, so every level is offered and the gateway refuses
  // the ones the model does not take.
  const allowed = value.manual
    ? efforts
    : efforts.filter((effort) => selected?.reasoningEfforts.includes(effort.value));

  return { eligible, provider, models, list, selected, allowed };
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
  /** A delay in ms before saving; a menu choice saves at once, a typed id after a pause. */
  change: (role: Role, patch: Partial<RoleValue>, delay?: number) => void;
}) {
  const { eligible, models, list, selected, allowed } = describeRole(role, value, data, configured);

  return (
    <>
      {selected && !selected.known && (
        <Badge tone="warn">Capabilities unknown: conservative limits</Badge>
      )}
      {list?.stale && (
        <p className="note" role="status">
          The list is stale: the provider did not answer the last read.
        </p>
      )}
      <div className="settings-fields">
        <Field label="Provider">
          <Select
            value={value.providerId}
            disabled={busy}
            onValueChange={(providerId) =>
              change(role.key, {
                providerId,
                modelId: '',
                reasoningEffort: '',
                manual: false,
              })
            }
            options={[
              { value: '', label: 'Automatic' },
              ...eligible.map((provider) => ({
                value: provider.id,
                label: `${provider.name}${provider.kind === 'openai' ? (provider.authMode === 'codex' ? ' · ChatGPT' : ' · API key') : ''}`,
              })),
              ...(role.key === 'image' && !hasOpenAIKey
                ? [
                    {
                      value: '__openai_key_required__',
                      label: 'OpenAI · API key required',
                      disabled: true,
                    },
                  ]
                : []),
              ...(value.providerId && !eligible.some((provider) => provider.id === value.providerId)
                ? [
                    {
                      value: value.providerId,
                      label: 'Saved provider (unavailable for this activity)',
                    },
                  ]
                : []),
            ]}
          />
        </Field>
        {role.key === 'image' && !hasOpenAIKey && (
          <p className="note">
            <a href="/ui/providers/">Configure an OpenAI API key in Providers.</a> ChatGPT login
            does not authorize image generation.
          </p>
        )}
        <Field
          label="Model"
          hint={
            value.manual
              ? 'An id typed by hand. Use it when the provider publishes no list.'
              : undefined
          }
        >
          {value.manual ? (
            <input
              type="text"
              value={value.modelId}
              disabled={busy || !value.providerId}
              maxLength={160}
              placeholder="Model id"
              onChange={(event) => change(role.key, { modelId: event.target.value }, undefined)}
            />
          ) : (
            <Select
              value={value.modelId}
              disabled={busy || !value.providerId}
              onValueChange={(modelId) =>
                modelId === '__manual__'
                  ? change(role.key, { manual: true, modelId: '', reasoningEffort: '' })
                  : change(role.key, { modelId, reasoningEffort: '' })
              }
              options={[
                { value: '', label: 'Automatic' },
                ...models.map((model) => ({ value: model.id, label: modelLabel(model) })),
                { value: '__manual__', label: 'Type an id…' },
              ]}
            />
          )}
        </Field>
        <Field
          label="Effort"
          hint={allowed.length ? undefined : 'No reasoning levels are catalogued for this model.'}
        >
          <Select
            value={value.reasoningEffort}
            disabled={busy || !allowed.length}
            onValueChange={(reasoningEffort) => change(role.key, { reasoningEffort })}
            options={[{ value: '', label: "The provider's own default" }, ...allowed]}
          />
        </Field>
      </div>
    </>
  );
}
