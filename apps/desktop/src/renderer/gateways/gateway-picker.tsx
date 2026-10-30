import { Picker, PickerAction, PickerRow } from '@jian/ui';
import { Laptop, Plus } from 'lucide-react';
import { useState } from 'react';
import type { GatewayStatus, GatewaySummary } from '../../shared/bridge';

const DOT: Record<GatewayStatus, string> = {
  online: 'bg-good',
  connecting: 'bg-muted',
  incompatible: 'bg-warn',
  offline: 'bg-bad',
  unauthorized: 'bg-bad',
};

const SAID: Record<GatewayStatus, string> = {
  online: 'Connected',
  connecting: 'Connecting',
  incompatible: 'Another release',
  offline: 'Not answering',
  unauthorized: 'Token refused',
};

/** Where a gateway is, as people say it: its host, without the scheme. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Mark({ gateway }: { gateway: GatewaySummary }) {
  return gateway.local ? (
    <Laptop size={14} aria-hidden="true" />
  ) : (
    <span className={`size-2 rounded-full ${DOT[gateway.status]}`} aria-hidden="true" />
  );
}

/**
 * The gateway in use, in the status bar: every one the app knows, how each stands and its
 * unread chats; switching shows its agents, its gear opens its connection.
 */
export function GatewayPicker({
  gateways,
  current,
  select,
  openSettings,
  connect,
}: {
  gateways: GatewaySummary[];
  current?: GatewaySummary;
  select: (id: string) => void;
  openSettings: (id: string) => void;
  connect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unread = gateways
    .filter((gateway) => gateway.id !== current?.id)
    .reduce((sum, gateway) => sum + gateway.unread, 0);
  const close = (then: () => void) => () => {
    setOpen(false);
    then();
  };

  return (
    <Picker
      label="Gateway"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          {current && <Mark gateway={current} />}
          <span className="truncate">{current?.name ?? 'No gateway'}</span>
          {/* Replies waiting on the gateways not shown, so none goes unseen. */}
          {unread > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-on-accent">
              {unread}
              <span className="sr-only"> unread elsewhere</span>
            </span>
          )}
        </>
      }
      footer={
        <PickerAction icon={<Plus size={15} />} onClick={close(connect)}>
          Connect a gateway
        </PickerAction>
      }
    >
      {gateways.map((gateway) => (
        <PickerRow
          key={gateway.id}
          leading={<Mark gateway={gateway} />}
          label={gateway.unread > 0 ? `${gateway.name} · ${gateway.unread} unread` : gateway.name}
          detail={`${gateway.local ? 'On this computer' : hostOf(gateway.url)} · ${SAID[gateway.status]}`}
          selected={gateway.id === current?.id}
          onPick={close(() => select(gateway.id))}
          onSettings={close(() => openSettings(gateway.id))}
        />
      ))}
    </Picker>
  );
}
