'use client';

import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useModelCatalog } from '@/lib/query/agent';
import type { GatewayApi, ReasoningEffort, Session } from '../../lib/api';
import { efforts, usableProviders } from '../providers/catalog';
import {
  choiceOf,
  modelChoices,
  preferredModelSelection,
  withDefaultEffort,
} from '../providers/role-fields';
import { ProviderLogo } from '../ui';
import { Select } from '../ui/select';

/**
 * The model one conversation runs on, over the profile's defaults, and its reasoning effort.
 * It applies from the next turn; one already under way keeps the model it started with.
 */
export function SessionModel({
  api,
  profileId,
  session,
  draftModel,
  onDraftChange,
  className,
  channel,
  saved,
}: {
  api: GatewayApi;
  profileId: string;
  session?: Session;
  draftModel?: Session['model'];
  onDraftChange?: (model: Session['model']) => void;
  className?: string;
  /** A WhatsApp or Telegram conversation, which follows the Channels default. */
  channel: boolean;
  saved: () => void;
}) {
  const [savedModel, setSavedModel] = useState(session?.model);
  const [busy, setBusy] = useState(false);
  const initialSave = useRef(false);
  const catalog = useModelCatalog();
  const providers = usableProviders(catalog);
  const fallback =
    (channel ? catalog.modelDefaults.channel : undefined) ??
    catalog.modelDefaults.conversation ??
    preferredModelSelection('conversation', catalog, providers);
  const model = withDefaultEffort(
    session ? (savedModel ?? session.model ?? fallback) : (draftModel ?? fallback),
    catalog,
  );
  const choices = modelChoices('conversation', catalog, providers).map((choice) => {
    const providerId = choice.value.slice(0, choice.value.indexOf(':'));
    const provider = providers.find((item) => item.id === providerId);
    return {
      ...choice,
      detail: undefined,
      ...(provider ? { icon: <ProviderLogo kind={provider.kind} size={16} /> } : {}),
    };
  });
  const current = model ? choiceOf(model.providerId, model.modelId) : '';
  const listed = model
    ? catalog.providerModels[model.providerId]?.models.find((item) => item.id === model.modelId)
    : undefined;
  const allowed = efforts.filter((effort) => listed?.reasoningEfforts.includes(effort.value));
  useEffect(() => {
    if (!session || session.channel !== GATEWAY_SESSION_CHANNEL || !model || initialSave.current) {
      return;
    }
    initialSave.current = true;
    if (JSON.stringify(session.model) === JSON.stringify(model)) return;

    setSavedModel(model);
    setBusy(true);
    void api
      .setSessionModel(profileId, session.id, model)
      .then(saved)
      .catch((error: unknown) => {
        toast.error(
          error instanceof Error ? error.message : 'The conversation model could not be saved.',
        );
      })
      .finally(() => setBusy(false));
  }, [api, model, profileId, saved, session]);

  useEffect(() => {
    if (!session && !draftModel && model) onDraftChange?.(model);
  }, [draftModel, model, onDraftChange, session]);

  const save = async (next: Session['model']) => {
    const previous = model;
    const selection = withDefaultEffort(next, catalog);

    if (session) setSavedModel(selection);
    else onDraftChange?.(selection);
    setBusy(true);

    try {
      if (session) await api.setSessionModel(profileId, session.id, selection ?? null);
      saved();
    } catch (error) {
      setSavedModel(previous);
      toast.error(error instanceof Error ? error.message : 'The model could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`session-model ${className ?? ''}`}>
      <Select
        aria-label="Model for this conversation"
        className="composer-select-ghost"
        popupClassName="composer-model-popup"
        value={current}
        disabled={busy}
        onValueChange={(choice) => {
          if (!choice) return void save(undefined);

          const split = choice.indexOf(':');

          void save({ providerId: choice.slice(0, split), modelId: choice.slice(split + 1) });
        }}
        placeholder="No model available"
        renderValue={(option) => option?.label}
        options={[
          ...choices,
          ...(current && !choices.some((choice) => choice.value === current)
            ? [
                {
                  value: current,
                  label: model?.modelId ?? current,
                  detail: 'No longer offered',
                  ...(providers.find((provider) => provider.id === model?.providerId)
                    ? {
                        icon: (
                          <ProviderLogo
                            kind={
                              providers.find((provider) => provider.id === model?.providerId)
                                ?.kind ?? ''
                            }
                            size={16}
                          />
                        ),
                      }
                    : {}),
                },
              ]
            : []),
        ]}
      />
      <Select
        aria-label="Reasoning effort for this conversation"
        className="composer-select-ghost"
        value={model?.reasoningEffort ?? ''}
        disabled={busy || !model || !allowed.length}
        onValueChange={(effort) =>
          model &&
          void save({
            providerId: model.providerId,
            modelId: model.modelId,
            ...(effort ? { reasoningEffort: effort as ReasoningEffort } : {}),
          })
        }
        placeholder="Effort"
        options={allowed}
      />
    </div>
  );
}
