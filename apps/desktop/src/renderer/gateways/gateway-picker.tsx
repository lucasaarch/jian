import { HoverTip, Picker, PickerAction, PickerRow, reconnectGateway } from '@jian/ui';
import { Laptop, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type GatewaySummary, STATUS_SAID } from '../../shared/bridge';
import { desktop } from '../desktop';
import { STATUS_DOT } from './status';

/**
 * Said under a gateway only when there is something to read: connected is what the dot already
 * says, and one not answering has its way to reconnect beside it.
 */
function detailOf(gateway: GatewaySummary): string | undefined {
  return gateway.status === 'online' || gateway.status === 'offline'
    ? undefined
    : STATUS_SAID[gateway.status];
}

/** How long the button turns after a click, in ms: the answer comes through the gateway's status. */
const TRYING_MS = 1_200;

/** Asks a gateway that is not answering again now, and the panel open on it to read everything. */
function Reconnect({ gateway, open }: { gateway: GatewaySummary; open: boolean }) {
  const [trying, setTrying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const label = `Reconnect to ${gateway.name}`;
  return (
    <HoverTip tip={label}>
      <button
        type="button"
        aria-label={label}
        disabled={trying}
        onClick={() => {
          desktop().reconnectGateway(gateway.id);
          if (open) reconnectGateway();
          setTrying(true);
          timer.current = setTimeout(() => setTrying(false), TRYING_MS);
        }}
        className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-muted transition-colors hover:bg-glass-press hover:text-ink"
      >
        <RefreshCw size={14} className={trying ? 'animate-spin' : ''} aria-hidden="true" />
      </button>
    </HoverTip>
  );
}

function Mark({ gateway }: { gateway: GatewaySummary }) {
  return gateway.local ? (
    <Laptop size={14} aria-hidden="true" />
  ) : (
    <span className={`size-2 rounded-full ${STATUS_DOT[gateway.status]}`} aria-hidden="true" />
  );
}

const badge =
  'grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-on-accent';

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
            <span className={badge}>
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
        const away = gateway.status === 'offline';
        return (
          <PickerRow
            key={gateway.id}
            leading={<Mark gateway={gateway} />}
            label={gateway.name}
            {...(gateway.unread > 0 && !away
              ? {
                  trailing: (
                    <span className={badge}>
                      {gateway.unread}
                      <span className="sr-only"> unread</span>
                    </span>
                  ),
                }
              : {})}
            {...(detail ? { detail } : {})}
            {...(away
              ? { action: <Reconnect gateway={gateway} open={gateway.id === current?.id} /> }
              : {})}
            selected={gateway.id === current?.id}
            onPick={close(() => select(gateway.id))}
          />
        );
      })}
    </Picker>
  );
}
