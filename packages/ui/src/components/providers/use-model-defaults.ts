'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  GatewayApi,
  ModelDefaultsInput,
  ModelSelection,
  ReasoningEffort,
} from '../../lib/api';
import { useAutosave } from '../../lib/autosave';
import { useModelCatalog } from '../../lib/query/agent';
import { useRefresh } from '../../lib/workspace';
import { type Role, roles, usableProviders } from './catalog';
import { preferredModelSelection, type RoleValue, withDefaultEffort } from './role-choices';

const empty: RoleValue = {
  providerId: '',
  modelId: '',
  reasoningEffort: '',
  disabled: false,
};

function initial(selection: ModelSelection | 'disabled' | null): RoleValue {
  if (selection === 'disabled') return { ...empty, disabled: true };
  if (!selection) return empty;

  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    reasoningEffort: selection.reasoningEffort ?? '',
    voiceName: selection.voiceName,
    disabled: false,
  };
}

function toSelection(value: RoleValue): ModelSelection | 'disabled' | null {
  if (value.disabled) return 'disabled';
  if (!value.providerId || !value.modelId.trim()) return null;

  return {
    providerId: value.providerId,
    modelId: value.modelId.trim(),
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort as ReasoningEffort } : {}),
    ...(value.voiceName ? { voiceName: value.voiceName } : {}),
  };
}

/**
 * The installation's model per activity, as the owner edits it. What was never saved starts at
 * the preferred model, so the first change saves a complete set. A choice is final: it is saved
 * at once, and the next save waits for it. Changing the conversation model moves the channel
 * model with it, since the screens offer one choice for both.
 */
export function useModelDefaults(api: GatewayApi) {
  const catalog = useModelCatalog();
  const configured = usableProviders(catalog);
  const hasOpenAIKey = configured.some(
    (provider) => provider.kind === 'openai' && provider.authMode !== 'codex',
  );
  const [values, setValues] = useState<Record<Role, RoleValue>>(() => {
    const defaultConversation =
      catalog.modelDefaults.conversation ??
      preferredModelSelection('conversation', catalog, configured);
    return Object.fromEntries(
      roles.map((role) => {
        const saved = catalog.modelDefaults[role.key];
        const fallback =
          role.key === 'channel' || role.key === 'compaction'
            ? defaultConversation
            : preferredModelSelection(role.key, catalog, configured);
        const selection = saved ?? fallback ?? null;
        const resolved =
          selection && selection !== 'disabled' && role.tools
            ? withDefaultEffort(selection, catalog)
            : selection;
        return [role.key, initial(resolved ?? null)];
      }),
    ) as Record<Role, RoleValue>;
  });

  const refresh = useRefresh();
  const latest = useRef(values);

  const { schedule, flush } = useAutosave(async () => {
    try {
      await api.setModelDefaults(
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
    const updated = { ...latest.current[role], ...patch };
    const next = {
      ...latest.current,
      [role]: updated,
      ...(role === 'conversation' ? { channel: updated } : {}),
    };

    latest.current = next;
    setValues(next);
    schedule(0);
  };

  // A channel model saved apart from the conversation one, which the next change will replace.
  const separateChannel =
    JSON.stringify(toSelection(values.channel)) !==
    JSON.stringify(toSelection(values.conversation));

  return { catalog, configured, hasOpenAIKey, values, change, flush, separateChannel };
}
