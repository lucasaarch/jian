'use client';

import { supportsModelRole, supportsProviderRole } from '@jian/contracts';
import { Check } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  ModelDefaultsInput,
  ModelSelection,
  ProfileData,
  ReasoningEffort,
} from '../../lib/api';
import { useAutosave } from '../../lib/autosave';
import { useWorkspace } from '../../lib/workspace';
import type { SectionProps } from '../props';
import { Badge, Empty, Field, SectionHeading } from '../ui';
import { Select } from '../ui/select';
import { efforts, modelLabel, type Role, roles, usableProviders } from './catalog';

type RoleValue = {
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  /** The id was typed instead of picked, so the panel knows nothing about its capabilities. */
  manual: boolean;
};

const empty: RoleValue = { providerId: '', modelId: '', reasoningEffort: '', manual: false };

function initial(data: ProfileData, selection: ModelSelection | null): RoleValue {
  if (!selection) return empty;

  const listed = (data.providerModels[selection.providerId]?.models ?? []).some(
    (model) => model.id === selection.modelId,
  );

  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    reasoningEffort: selection.reasoningEffort ?? '',
    manual: !listed,
  };
}

function toSelection(value: RoleValue): ModelSelection | null {
  if (!value.providerId || !value.modelId.trim()) return null;

  return {
    providerId: value.providerId,
    modelId: value.modelId.trim(),
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort as ReasoningEffort } : {}),
  };
}

export function ModelDefaults({ profile, data, api, busy }: SectionProps) {
  const configured = usableProviders(data);
  const hasOpenAIKey = configured.some(
    (provider) => provider.kind === 'openai' && provider.authMode !== 'codex',
  );
  const [values, setValues] = useState<Record<Role, RoleValue>>(
    () =>
      Object.fromEntries(
        roles.map((role) => [role.key, initial(data, data.modelDefaults[role.key])]),
      ) as Record<Role, RoleValue>,
  );

  const { refresh } = useWorkspace();
  const latest = useRef(values);

  // A choice in a menu is final: it is saved at once, and the next one waits for it.
  const { schedule, flush } = useAutosave(async () => {
    try {
      await api.setModelDefaults(
        profile.id,
        Object.fromEntries(
          roles.map((role) => [role.key, toSelection(latest.current[role.key])]),
        ) as ModelDefaultsInput,
      );
      toast.success('Model defaults saved.', { id: 'model-defaults-autosave' });
      void refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The defaults could not be saved.', {
        id: 'model-defaults-autosave',
      });
    }
  });

  const change = (role: Role, patch: Partial<RoleValue>) => {
    const next = { ...latest.current, [role]: { ...latest.current[role], ...patch } };

    latest.current = next;
    setValues(next);
    schedule(0);
  };

  if (!configured.length) {
    return (
      <>
        <SectionHeading
          title="Model defaults"
          description="One model per activity. Any of them may stay empty."
        />
        <Empty title="Configure a provider first">
          Models show up here once a connection is ready.
        </Empty>
      </>
    );
  }

  return (
    <>
      <SectionHeading
        title="Model defaults"
        description="Choose the model and the reasoning effort for each activity."
      />
      <form
        method="post"
        action="/ui/"
        onSubmit={(event) => {
          event.preventDefault();
          void flush();
        }}
      >
        {roles.map((role) => {
          const value = values[role.key];
          const eligible = configured.filter((provider) =>
            supportsProviderRole(provider, role.key),
          );
          const provider = configured.find((item) => item.id === value.providerId);
          const models = (data.providerModels[value.providerId]?.models ?? []).filter(
            (model) => !provider || supportsModelRole(provider, model, role.key),
          );
          const list = value.providerId ? data.providerModels[value.providerId] : undefined;
          const selected = models.find((model) => model.id === value.modelId);
          // A typed id has no capability row here, so every level is offered and the gateway
          // refuses the ones the model does not take.
          const allowed = value.manual
            ? efforts
            : efforts.filter((effort) => selected?.reasoningEfforts.includes(effort.value));

          return (
            <div className="settings-section" key={role.key}>
              <div className="settings-caption">
                <h2>{role.label}</h2>
                <p>{role.hint}</p>
                {selected && !selected.known && (
                  <Badge tone="warn">Capabilities unknown: conservative limits</Badge>
                )}
                {list?.stale && (
                  <p className="note" role="status">
                    The list is stale: the provider did not answer the last read.
                  </p>
                )}
              </div>
              <div className="settings-fields">
                <Field label={`Provider · ${role.label}`}>
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
                      ...(value.providerId &&
                      !eligible.some((provider) => provider.id === value.providerId)
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
                    <a href="/ui/providers/">Configure an OpenAI API key in Providers.</a> ChatGPT
                    login does not authorize image generation.
                  </p>
                )}
                <Field
                  label={`Model · ${role.label}`}
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
                      onChange={(event) => change(role.key, { modelId: event.target.value })}
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
                  label={`Effort · ${role.label}`}
                  hint={
                    allowed.length
                      ? undefined
                      : 'No reasoning levels are catalogued for this model.'
                  }
                >
                  <Select
                    value={value.reasoningEffort}
                    disabled={busy || !allowed.length}
                    onValueChange={(reasoningEffort) => change(role.key, { reasoningEffort })}
                    options={[{ value: '', label: "The provider's own default" }, ...allowed]}
                  />
                </Field>
              </div>
            </div>
          );
        })}
        <p className="autosave-note">
          <Check size={14} /> Each choice is saved as you make it.
        </p>
      </form>
    </>
  );
}
