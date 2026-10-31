'use client';

import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { GatewayApi, ModelDefaults, ModelDefaultsInput, Session } from '../../lib/api';
import { useModelCatalog } from '../../lib/query/agent';
import { keys } from '../../lib/query/keys';
import { usableProviders } from '../providers/catalog';
import { preferredModelSelection, withDefaultEffort } from '../providers/role-choices';
import { modelEntries } from './model-entries';
import { EffortMenu, type MenuAlign, ModelMenu } from './model-menu';

/**
 * A choice in a composer is where the next new chat starts, and only that: other conversations
 * keep the model they have. Worth having, not worth failing over: a gateway from before this
 * answers no, and the conversation has its model regardless. It is held until the gateway answers,
 * so a read of the defaults that follows cannot bring the old one back.
 */
function useRememberModel(api: GatewayApi) {
  const client = useQueryClient();

  return async (model: NonNullable<Session['model']>) => {
    const defaults = client.getQueryData<ModelDefaults>(keys.modelDefaults);
    if (!defaults || JSON.stringify(model) === JSON.stringify(defaults.conversation)) return;
    client.setQueryData<ModelDefaults>(keys.modelDefaults, { ...defaults, conversation: model });
    const { updatedAt: _saved, ...input } = defaults;
    await api
      .setModelDefaults({ ...input, conversation: model } as ModelDefaultsInput)
      .catch(() => {});
  };
}

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
  menuAlign,
  remembers = false,
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
  /** Where the menus line up with their triggers; the end unless the controls sit on the left. */
  menuAlign?: MenuAlign;
  /** A composer's: what the owner picks here is also where their next new chat starts. */
  remembers?: boolean;
}) {
  const [savedModel, setSavedModel] = useState(session?.model);
  const [busy, setBusy] = useState(false);
  const initialSave = useRef(false);
  const remember = useRememberModel(api);
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
      if (remembers && selection) await remember(selection);
      saved();
    } catch (error) {
      setSavedModel(previous);
      toast.error(error instanceof Error ? error.message : 'The model could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  const entries = modelEntries('conversation', catalog, providers, model);

  return (
    <div className={`session-model ${className ?? ''}`}>
      <ModelMenu
        label="Model for this conversation"
        models={entries}
        value={model}
        disabled={busy}
        align={menuAlign}
        onChange={(next) => void save(next)}
      />
      <EffortMenu
        model={entries.find(
          (entry) => entry.providerId === model?.providerId && entry.modelId === model?.modelId,
        )}
        value={model}
        disabled={busy}
        align={menuAlign}
        onChange={(next) => void save(next)}
      />
    </div>
  );
}
