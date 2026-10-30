import { Menu } from '@base-ui/react/menu';
import { Check, Laptop, Plus, Settings2 } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { GatewayStatus, GatewaySummary } from '../../shared/bridge';
import { desktop } from '../desktop';
import { forget } from './navigation';

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

/** What the button's tooltip says: where the gateway is, how it stands, its release. */
function describe(gateway: GatewaySummary): string {
  const where = gateway.local ? 'Runs on this computer' : gateway.url;
  return [where, SAID[gateway.status], gateway.version].filter(Boolean).join(' · ');
}

const itemClass =
  'flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-ink outline-none data-highlighted:bg-accent-soft';

/**
 * The app's own chrome, under the panel: every gateway with how it stands and its unread chats,
 * the one shown, and a way to connect another. The panel above belongs to the gateway chosen here.
 */
export function GatewayBar({
  gateways,
  current,
  select,
  add,
}: {
  gateways: GatewaySummary[];
  current?: GatewaySummary;
  select: (id: string) => void;
  add: () => void;
}) {
  const [renaming, setRenaming] = useState<string>();

  return (
    <nav
      aria-label="Gateways"
      className="flex h-(--gateway-bar) shrink-0 items-center gap-1 border-t border-line bg-canvas px-2 text-xs text-muted"
    >
      <ul className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {gateways.map((gateway) => (
          <li key={gateway.id} className="shrink-0">
            {renaming === gateway.id ? (
              <Rename gateway={gateway} done={() => setRenaming(undefined)} />
            ) : (
              <button
                type="button"
                onClick={() => select(gateway.id)}
                onDoubleClick={() => !gateway.local && setRenaming(gateway.id)}
                aria-current={gateway.id === current?.id ? 'page' : undefined}
                title={describe(gateway)}
                className="flex h-6 items-center gap-1.5 rounded-md px-2 hover:bg-accent-soft hover:text-ink aria-[current=page]:bg-accent-soft aria-[current=page]:text-ink"
              >
                {gateway.local ? (
                  <Laptop size={13} aria-hidden="true" />
                ) : (
                  <span
                    className={`size-1.5 rounded-full ${DOT[gateway.status]}`}
                    aria-hidden="true"
                  />
                )}
                <span className="max-w-40 truncate">{gateway.name}</span>
                <span className="sr-only">, {SAID[gateway.status]}</span>
                {gateway.unread > 0 && (
                  <span className="rounded-full bg-accent px-1.5 text-[0.65rem] font-semibold leading-4 text-on-accent">
                    {gateway.unread}
                    <span className="sr-only"> unread</span>
                  </span>
                )}
              </button>
            )}
          </li>
        ))}
        <li className="shrink-0">
          <button
            type="button"
            onClick={add}
            aria-label="Connect a gateway"
            title="Connect a gateway"
            className="grid size-6 place-items-center rounded-md hover:bg-accent-soft hover:text-ink"
          >
            <Plus size={14} />
          </button>
        </li>
      </ul>
      <AppMenu current={current} rename={(id) => setRenaming(id)} />
    </nav>
  );
}

/** A gateway's name, edited in place: Enter keeps it, Escape or leaving the field drops it. */
function Rename({ gateway, done }: { gateway: GatewaySummary; done: () => void }) {
  const [name, setName] = useState(gateway.name);
  const field = useRef<HTMLInputElement>(null);
  // The field appears because the owner asked to rename: it takes the keyboard at once.
  useEffect(() => field.current?.select(), []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && name.trim() !== gateway.name) void desktop().renameGateway(gateway.id, name);
    done();
  };
  return (
    <form onSubmit={submit}>
      <input
        ref={field}
        aria-label={`Rename ${gateway.name}`}
        value={name}
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        onBlur={done}
        onKeyDown={(event) => {
          if (event.key === 'Escape') done();
        }}
        className="h-6 w-40 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none"
      />
    </form>
  );
}

function AppMenu({ current, rename }: { current?: GatewaySummary; rename: (id: string) => void }) {
  const [openAtLogin, setOpenAtLogin] = useState<boolean>();
  useEffect(() => {
    void desktop().openAtLogin().then(setOpenAtLogin);
  }, []);

  const remove = () => {
    if (!current) return;
    // The token is forgotten with it; connecting again means typing it again.
    if (
      window.confirm(
        `Remove ${current.name} from the app? Its token is forgotten on this computer.`,
      )
    ) {
      // Its place in the panel goes with it.
      forget(current.id);
      void desktop().removeGateway(current.id);
    }
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="App settings"
        title="App settings"
        className="grid size-6 shrink-0 place-items-center rounded-md hover:bg-accent-soft hover:text-ink data-popup-open:bg-accent-soft"
      >
        <Settings2 size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className="model-menu p-1.5">
            {current && !current.local && (
              <>
                <Menu.Item className={itemClass} onClick={() => rename(current.id)}>
                  Rename {current.name}
                </Menu.Item>
                <Menu.Item className={`${itemClass} text-bad`} onClick={remove}>
                  Remove {current.name}…
                </Menu.Item>
                <Menu.Separator className="my-1 h-px bg-line" />
              </>
            )}
            <Menu.CheckboxItem
              className={itemClass}
              checked={openAtLogin === true}
              onCheckedChange={(checked) => {
                setOpenAtLogin(checked);
                void desktop().setOpenAtLogin(checked);
              }}
            >
              <span className="grid size-4 place-items-center">
                <Menu.CheckboxItemIndicator>
                  <Check size={14} />
                </Menu.CheckboxItemIndicator>
              </span>
              Open Jian at login
            </Menu.CheckboxItem>
            <div className="px-2.5 pb-1 pt-2 text-xs text-muted">Jian {desktop().version}</div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
