'use client';

import { SlidersHorizontal } from 'lucide-react';
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
import { Button, Empty, Modal, SectionHeading } from '../ui';
import { modelLabel, type Role, roles, usableProviders } from './catalog';
import { describeRole, RoleFields, type RoleValue } from './role-fields';

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

  const change = (role: Role, patch: Partial<RoleValue>, delay = 0) => {
    const next = { ...latest.current, [role]: { ...latest.current[role], ...patch } };

    latest.current = next;
    setValues(next);
    schedule(delay);
  };
  const [open, setOpen] = useState<Role>();
  const editing = roles.find((role) => role.key === open);

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
        <div className="model-grid">
          {roles.map((role) => {
            const value = values[role.key];
            const { provider, selected, allowed } = describeRole(role, value, data, configured);
            const effort = allowed.find((item) => item.value === value.reasoningEffort);

            return (
              <article className="model-card" key={role.key}>
                <h2>{role.label}</h2>
                <p className="model-card-hint">{role.hint}</p>
                <div className="model-card-choice">
                  {provider && value.modelId ? (
                    <>
                      <strong>{selected ? modelLabel(selected, role.tools) : value.modelId}</strong>
                      <small>
                        {provider.name}
                        {effort ? ` · ${effort.label}` : ''}
                      </small>
                    </>
                  ) : (
                    <>
                      <strong>Automatic</strong>
                      <small>The fallback described above</small>
                    </>
                  )}
                </div>
                <Button variant="secondary" disabled={busy} onClick={() => setOpen(role.key)}>
                  <SlidersHorizontal size={16} />
                  Configure
                </Button>
              </article>
            );
          })}
        </div>
      </form>
      {editing && (
        <Modal
          title={editing.label}
          description={editing.hint}
          close={() => setOpen(undefined)}
          footer={<Button onClick={() => setOpen(undefined)}>Done</Button>}
        >
          <RoleFields
            role={editing}
            value={values[editing.key]}
            data={data}
            configured={configured}
            hasOpenAIKey={hasOpenAIKey}
            busy={busy}
            change={change}
          />
        </Modal>
      )}
    </>
  );
}
