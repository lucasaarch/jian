'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ModelDefaultsInput, ModelSelection, ReasoningEffort } from '../../lib/api';
import { useAutosave } from '../../lib/autosave';
import { useWorkspace } from '../../lib/workspace';
import type { SectionProps } from '../props';
import { SectionHeading } from '../ui';
import { type Role, roles, usableProviders } from './catalog';
import {
  preferredModelSelection,
  RoleFields,
  type RoleValue,
  withDefaultEffort,
} from './role-fields';

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

export function ModelDefaults({ profile, data, api, busy }: SectionProps) {
  const configured = usableProviders(data);
  const hasOpenAIKey = configured.some(
    (provider) => provider.kind === 'openai' && provider.authMode !== 'codex',
  );
  const [values, setValues] = useState<Record<Role, RoleValue>>(() => {
    const defaultConversation =
      data.modelDefaults.conversation ?? preferredModelSelection('conversation', data, configured);
    return Object.fromEntries(
      roles.map((role) => {
        const saved = data.modelDefaults[role.key];
        const fallback =
          role.key === 'channel' || role.key === 'compaction'
            ? defaultConversation
            : preferredModelSelection(role.key, data, configured);
        const selection = saved ?? fallback ?? null;
        const resolved =
          selection && selection !== 'disabled' && role.tools
            ? withDefaultEffort(selection, data)
            : selection;
        return [role.key, initial(resolved ?? null)];
      }),
    ) as Record<Role, RoleValue>;
  });

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
  return (
    <>
      <SectionHeading
        title="Model defaults"
        description="Choose a default model for each activity, or disable optional activities. New setups prefer Claude Opus 5.5 when available, then GPT-6 Astra, then another compatible model."
      />
      <form
        method="post"
        action="/"
        onSubmit={(event) => {
          event.preventDefault();
          void flush();
        }}
      >
        <div className="model-grid">
          {roles
            .filter((role) => role.key !== 'channel')
            .map((role) => {
              const value = values[role.key];
              return (
                <article className="model-card" key={role.key}>
                  <h2>{role.label}</h2>
                  <p className="model-card-hint">{role.hint}</p>
                  {role.key === 'conversation' &&
                    JSON.stringify(toSelection(values.channel)) !==
                      JSON.stringify(toSelection(values.conversation)) && (
                      <p className="note" role="status">
                        A separate channel default is saved. It remains in use until you change this
                        model; then both defaults will match.
                      </p>
                    )}
                  <RoleFields
                    role={role}
                    value={value}
                    data={data}
                    configured={configured}
                    hasOpenAIKey={hasOpenAIKey}
                    busy={busy}
                    change={change}
                  />
                </article>
              );
            })}
        </div>
      </form>
    </>
  );
}
