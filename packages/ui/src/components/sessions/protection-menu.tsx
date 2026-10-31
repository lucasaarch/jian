'use client';

import type { GatewaySettings } from '@jian/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ShieldCheck, ShieldHalf, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { GatewayApi, ProtectionMode, Session } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { Menu, type MenuAlign } from './model-menu';

const modes: Array<{
  value: ProtectionMode;
  label: string;
  detail: string;
  icon: typeof ShieldCheck;
}> = [
  {
    value: 'ask',
    label: 'Ask first',
    detail: 'Asks before acting',
    icon: ShieldCheck,
  },
  {
    value: 'auto',
    label: 'Auto',
    detail: 'Blocks only what could destroy or leak',
    icon: ShieldHalf,
  },
  { value: 'full', label: 'Full access', detail: 'Acts without asking', icon: ShieldOff },
];

/**
 * Whether the agent asks before it acts in this conversation. A saved conversation changes
 * from its next action on; a draft keeps the choice until its first message creates it.
 */
export function SessionProtection({
  api,
  profileId,
  session,
  draft,
  onDraftChange,
  align,
  saved,
  remembers = false,
}: {
  api: GatewayApi;
  profileId: string;
  session?: Session;
  /** The new chat's choice, before the conversation exists. */
  draft?: ProtectionMode;
  onDraftChange?: (protection: ProtectionMode) => void;
  align?: MenuAlign;
  saved?: () => void;
  /** A composer's: what the owner picks here is also where their next new chat starts. */
  remembers?: boolean;
}) {
  const client = useQueryClient();
  // Worth having, not worth failing over: a gateway from before this answers no.
  const remember = async (protection: ProtectionMode) => {
    if (!remembers) return;
    client.setQueryData<GatewaySettings>(keys.settings, (known) =>
      known ? { ...known, newChatProtection: protection } : known,
    );
    await api.updateSettings({ newChatProtection: protection }).catch(() => {});
  };
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<ProtectionMode>();
  const [busy, setBusy] = useState(false);
  // Until anyone chooses, a conversation asks first.
  const value = (session ? (chosen ?? session.protection) : draft) ?? 'ask';
  const current = modes.find((mode) => mode.value === value) ?? modes[0];
  const Icon = current.icon;

  const choose = async (next: ProtectionMode) => {
    setOpen(false);
    if (next === value) return;
    if (!session) {
      onDraftChange?.(next);
      return void remember(next);
    }

    const previous = value;
    setChosen(next);
    setBusy(true);
    try {
      await api.setSessionProtection(profileId, session.id, next);
      await remember(next);
      saved?.();
    } catch (error) {
      setChosen(previous);
      toast.error(error instanceof Error ? error.message : 'The protection could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Menu
      label="Protection for this conversation"
      disabled={busy}
      align={align}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <span className="protection-trigger" data-mode={value}>
          <Icon size={15} aria-hidden="true" />
          <span className="model-trigger-name">{current.label}</span>
        </span>
      }
    >
      <fieldset aria-label="Protection">
        {modes.map((mode) => (
          <button
            key={mode.value}
            type="button"
            className="model-option"
            aria-pressed={mode.value === value}
            onClick={() => void choose(mode.value)}
          >
            <mode.icon size={15} aria-hidden="true" />
            <span className="model-option-name">
              {mode.label}
              <small>{mode.detail}</small>
            </span>
            {mode.value === value && <Check size={14} aria-hidden="true" />}
          </button>
        ))}
      </fieldset>
    </Menu>
  );
}
