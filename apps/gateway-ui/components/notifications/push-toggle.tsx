'use client';

import { Bell, BellOff, BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { type PushState, pushState, turnPushOff, turnPushOn } from '@/lib/push';
import { IconButton } from '../ui';

const labels: Record<PushState, string> = {
  on: 'Notifications are on on this device. Turn them off',
  off: 'Turn on notifications on this device',
  blocked: 'Notifications are blocked for Jian in this browser’s settings',
  unsupported:
    'This browser cannot show notifications. On an iPhone, add Jian to the Home Screen first',
};

/**
 * Notifications on this device for what the agent says in chats, on or off. The browser asks
 * for permission on the first press; once refused, only its own settings can allow them again.
 */
export function PushToggle() {
  const [state, setState] = useState<PushState>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void pushState().then(setState);
  }, []);

  if (!state) return null;

  const press = async () => {
    setBusy(true);
    try {
      const next = state === 'on' ? await turnPushOff() : await turnPushOn();
      setState(next);
      if (next === 'on') toast.success('Notifications are on for this device.');
      if (next === 'blocked') toast.error(labels.blocked);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Notifications could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <IconButton
      size="control"
      className="push-toggle"
      data-state={state}
      aria-label={labels[state]}
      title={labels[state]}
      aria-pressed={state === 'on'}
      disabled={busy || state === 'unsupported' || state === 'blocked'}
      onClick={() => void press()}
    >
      {state === 'on' ? (
        <BellRing size={18} />
      ) : state === 'off' ? (
        <Bell size={18} />
      ) : (
        <BellOff size={18} />
      )}
    </IconButton>
  );
}
