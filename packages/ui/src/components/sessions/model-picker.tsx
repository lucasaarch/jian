'use client';

import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { GatewayApi, Session } from '../../lib/api';
import { useModelCatalog } from '../../lib/query/agent';
import { usableProviders } from '../providers/catalog';
import { preferredModelSelection, withDefaultEffort } from '../providers/role-choices';
import { modelEntries } from './model-entries';
import { EffortMenu, type MenuAlign, ModelMenu } from './model-menu';

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
