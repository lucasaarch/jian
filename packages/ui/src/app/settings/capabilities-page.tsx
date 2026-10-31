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
import { SettingsGroup, SettingsPageSkeleton, SettingsRow, Skeleton } from '../../kit';
import type { ModelCatalog, Provider, ReasoningEffort } from '../../lib/api';
import { useActions } from '../../lib/workspace';

/** A saved effort is one of the levels the menus know, or none at all. */
const isEffort = (value: string): value is ReasoningEffort =>
  efforts.some((effort) => effort.value === value);

/** Each activity in a few words. A chat's own model is chosen in the chat, and remembered there. */
const said: Partial<Record<Role, string>> = {
  channel: 'Conversations on WhatsApp, Telegram and other channels, which have no model menu.',
  compaction: 'Summing up a long conversation.',
  image: 'Drawing images.',
  audio: 'Understanding voice notes and audio files.',
  speech: 'Spoken replies.',
};

/** What runs apart from the conversation's own model, which reads images and documents itself. */
const shownRoles = roles.filter((role) => role.key !== 'conversation');

/**
 * The capabilities while the models are read: each is known already, named and said as it will
 * be, and only its menu waits.
 */
export function CapabilitiesWaiting() {
  return (
    <SettingsPageSkeleton label="Loading capabilities…">
      <SettingsGroup title="Capabilities" note="Chats keep their own model">
        {shownRoles.map((role) => (
          <SettingsRow key={role.key} title={role.label} description={said[role.key]}>
            <Skeleton className="h-8 w-36 rounded-lg" />
          </SettingsRow>
        ))}
      </SettingsGroup>
    </SettingsPageSkeleton>
  );
}

/**
 * The models for what a conversation's own model does not do, a line each with the same model and
 * effort menus the composer has; optional ones can be switched off. Each choice is saved as it is
 * made. A chat's model is not here: a new chat starts with what the last one started with.
 */
export function CapabilitiesPage() {
  const { api, busy } = useActions();
  const { catalog, configured, hasOpenAIKey, values, change } = useModelDefaults(api);

  return (
    <SettingsGroup title="Capabilities" note="Chats keep their own model">
      {shownRoles.map((role) => (
        <ActivityRow
          key={role.key}
          role={role}
          value={values[role.key]}
          catalog={catalog}
          configured={configured}
          busy={busy}
          change={change}
          note={
            role.key === 'image' && !values.image.disabled && !values.image.modelId && !hasOpenAIKey
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
          {said[role.key]}
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
