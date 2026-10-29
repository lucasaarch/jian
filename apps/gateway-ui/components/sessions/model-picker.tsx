'use client';

import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useModelCatalog } from '@/lib/query/agent';
import type { GatewayApi, Session } from '../../lib/api';
import { usableProviders } from '../providers/catalog';
import {
  choiceOf,
  modelChoices,
  preferredModelSelection,
  withDefaultEffort,
} from '../providers/role-fields';
import { ProviderLogo } from '../ui';
import { type ModelEntry, ModelMenu } from './model-menu';

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

  // Every model the conversation can run on, with what each offers; the one it still names but
  // no provider offers any more stays listed, marked, so the menu never hides the current choice.
  const entries: ModelEntry[] = [
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
        ...(choice.icon ? { icon: choice.icon } : {}),
        efforts: offered?.reasoningEfforts ?? [],
        fast: Boolean(offered?.fast),
      };
    }),
    ...(model && current && !choices.some((choice) => choice.value === current)
      ? [
          {
            providerId: model.providerId,
            modelId: model.modelId,
            name: model.modelId,
            provider: '',
            efforts: [],
            fast: false,
            gone: true,
          },
        ]
      : []),
  ];

  return (
    <div className={`session-model ${className ?? ''}`}>
      <ModelMenu
        label="Model for this conversation"
        models={entries}
        value={model}
        disabled={busy}
        onChange={(next) => void save(next)}
      />
    </div>
  );
}
