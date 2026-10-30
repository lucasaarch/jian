'use client';

import type { ReactNode } from 'react';
import { efforts, type Role, roles } from '../../components/providers/catalog';
import {
  describeRole,
  modelOptions,
  pickModel,
  type RoleValue,
  voiceOptions,
} from '../../components/providers/role-choices';
import { useModelDefaults } from '../../components/providers/use-model-defaults';
import { modelEntries } from '../../components/sessions/model-entries';
import { EffortMenu, ModelMenu } from '../../components/sessions/model-menu';
import { Select } from '../../components/ui/select';
import { SettingsGroup, SettingsRow } from '../../kit';
import type { ModelCatalog, Provider, ReasoningEffort } from '../../lib/api';
import { useActions } from '../../lib/workspace';

/** A saved effort is one of the levels the menus know, or none at all. */
const isEffort = (value: string): value is ReasoningEffort =>
  efforts.some((effort) => effort.value === value);

/** Each activity in a few words; what it falls back to is the web's longer hint to explain. */
const said: Record<Exclude<Role, 'channel'>, string> = {
  conversation: 'Chats, the API and channels, unless a chat picks its own.',
  compaction: 'Summing up a long conversation.',
  image: 'Drawing images.',
  vision: 'Reading images the conversation model cannot.',
  audio: 'Voice notes and audio files.',
  speech: 'Spoken replies.',
};

/**
 * The model every agent uses for each activity, unless a conversation picks its own, a line
 * each with the same model and effort menus the composer has; optional activities can be
 * switched off. Each choice is saved as it is made. Channels follow the conversation model.
 */
export function ModelDefaultsPage() {
  const { api, busy } = useActions();
  const { catalog, configured, hasOpenAIKey, values, change, separateChannel } =
    useModelDefaults(api);

  return (
    <SettingsGroup title="Activities" note="A chat can still pick its own">
      {roles
        .filter((role) => role.key !== 'channel')
        .map((role) => (
          <ActivityRow
            key={role.key}
            role={role}
            value={values[role.key]}
            catalog={catalog}
            configured={configured}
            busy={busy}
            change={change}
            note={
              role.key === 'conversation' && separateChannel
                ? 'A separate channel default is saved; changing this model replaces it.'
                : role.key === 'image' &&
                    !values.image.disabled &&
                    !values.image.modelId &&
                    !hasOpenAIKey
                  ? // Only while nothing draws: once a Gemini or xAI model is chosen, no key is missing.
                    'Needs an OpenAI API key, Gemini or xAI under Providers.'
                  : undefined
            }
          />
        ))}
    </SettingsGroup>
  );
}

/** One activity: its model, and what that model lets be tuned — its effort, its voice. */
function ActivityRow({
  role,
  value,
  catalog,
  configured,
  busy,
  change,
  note,
}: {
  role: (typeof roles)[number];
  value: RoleValue;
  catalog: ModelCatalog;
  configured: Provider[];
  busy: boolean;
  change: (role: Role, patch: Partial<RoleValue>) => void;
  /** What the owner should know about the current choice. */
  note: ReactNode;
}) {
  const { provider, list } = describeRole(value, catalog, configured);
  const selection =
    value.providerId && value.modelId
      ? {
          providerId: value.providerId,
          modelId: value.modelId,
          ...(isEffort(value.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}),
        }
      : undefined;
  // The composer's own entries; a default carries no speed of its own, Fast is per conversation.
  const models = modelEntries(role.key, catalog, configured, selection).map((entry) => ({
    ...entry,
    fast: false,
  }));
  const optional = modelOptions(role, value, catalog, configured).options.some(
    (option) => option.value === 'disabled',
  );
  const model = models.find(
    (entry) => entry.providerId === value.providerId && entry.modelId === value.modelId,
  );

  return (
    <SettingsRow
      title={role.label}
      description={
        <>
          {said[role.key as Exclude<Role, 'channel'>]}
          {note && <span className="block text-ink/80">{note}</span>}
          {list?.stale && (
            <span role="status" className="block text-bad">
              The provider did not answer the last read.
            </span>
          )}
        </>
      }
    >
      <ModelMenu
        label={`${role.label} model`}
        models={models}
        {...(selection ? { value: selection } : {})}
        disabled={busy}
        side="bottom"
        {...(optional
          ? {
              off: {
                label: 'Disabled',
                chosen: value.disabled,
                choose: () => change(role.key, pickModel('disabled', catalog)),
              },
            }
          : {})}
        onChange={(next) =>
          change(role.key, {
            ...pickModel(`${next.providerId}:${next.modelId}`, catalog),
            ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {}),
          })
        }
      />
      {role.tools && !value.disabled && (
        <EffortMenu
          {...(model ? { model } : {})}
          {...(selection ? { value: selection } : {})}
          disabled={busy}
          side="bottom"
          onChange={(next) => change(role.key, { reasoningEffort: next.reasoningEffort ?? '' })}
        />
      )}
      {role.key === 'speech' && !value.disabled && provider && value.modelId && (
        <Select
          variant="ghost"
          popup="content"
          value={value.voiceName ?? ''}
          disabled={busy}
          aria-label={`${role.label} voice`}
          onValueChange={(voiceName) => change(role.key, { voiceName: voiceName || undefined })}
          options={voiceOptions(provider.kind)}
        />
      )}
    </SettingsRow>
  );
}
