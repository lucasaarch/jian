import { Picker, PickerAction, PickerRow } from '@jian/ui';
import { Laptop, Plus } from 'lucide-react';
import { useState } from 'react';
import { type GatewaySummary, STATUS_SAID } from '../../shared/bridge';
import { STATUS_DOT } from './status';

/** Said under a gateway only when it is not connected: connected is what the dot already says. */
function detailOf(gateway: GatewaySummary): string | undefined {
  return gateway.status === 'online' ? undefined : STATUS_SAID[gateway.status];
}

function Mark({ gateway }: { gateway: GatewaySummary }) {
  return gateway.local ? (
    <Laptop size={14} aria-hidden="true" />
  ) : (
    <span className={`size-2 rounded-full ${STATUS_DOT[gateway.status]}`} aria-hidden="true" />
  );
}

/**
 * The gateway in use, in the status bar: every one the app knows, how each stands and its
 * unread chats; switching shows its agents. Each one's details are in the app's settings.
 */
export function GatewayPicker({
  gateways,
  current,
  select,
  connect,
}: {
  gateways: GatewaySummary[];
  current?: GatewaySummary;
  select: (id: string) => void;
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
      {gateways.map((gateway) => {
        const detail = detailOf(gateway);
        return (
          <PickerRow
            key={gateway.id}
            leading={<Mark gateway={gateway} />}
            label={gateway.unread > 0 ? `${gateway.name} · ${gateway.unread} unread` : gateway.name}
            {...(detail ? { detail } : {})}
            selected={gateway.id === current?.id}
            onPick={close(() => select(gateway.id))}
          />
        );
      })}
    </Picker>
  );
}
