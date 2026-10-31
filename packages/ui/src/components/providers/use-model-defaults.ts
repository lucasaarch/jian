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
 * The installation's model per capability, as the owner edits it. What was never saved starts at
 * the preferred model, so the first change saves a complete set. A choice is final: it is saved
 * at once, and the next save waits for it. The conversation's own is not edited here: a new chat
 * writes it, and each save passes on the latest.
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
  const current = useRef(catalog.modelDefaults);
  current.current = catalog.modelDefaults;

  const { schedule, flush } = useAutosave(async () => {
    try {
      await api.setModelDefaults(
        Object.fromEntries(
          roles.map((role) => [
            role.key,
            role.key === 'conversation'
              ? current.current.conversation
              : toSelection(latest.current[role.key]),
          ]),
        ) as ModelDefaultsInput,
      );
      toast.success('Capabilities saved.', { id: 'model-defaults-autosave' });
      void refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That could not be saved.', {
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

  return { catalog, configured, hasOpenAIKey, values, change, flush };
}
