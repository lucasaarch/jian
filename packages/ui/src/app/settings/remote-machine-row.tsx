'use client';

import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  behind,
  type Machine,
  machineKind,
  machineSummary,
  updateWay,
  useMachineUpdate,
  versionLine,
} from '../../components/remote/machines';
import { Action, Overlay, SettingsRow, StatusPill, SwitchControl } from '../../kit';
import type { GatewayApi } from '../../lib/api';
import { CopyCommand } from './copy-command';

/** How the machine stands, in pills beside its name: presence, screen, release and OS. */
function MachinePills({ machine, version }: { machine: Machine; version: string | undefined }) {
  return (
    <>
      <StatusPill tone={machine.online ? 'good' : 'quiet'}>
        {machine.online ? 'Online' : 'Offline'}
      </StatusPill>
      {machine.online && machine.uiState === 'locked' && <StatusPill>Locked</StatusPill>}
      {machine.online && machine.uiState === 'display_asleep' && (
        <StatusPill>Display asleep</StatusPill>
      )}
      {machine.outdated ? (
        <StatusPill tone="bad">Update needed</StatusPill>
      ) : (
        behind(machine, version) && <StatusPill>Update available</StatusPill>
      )}
      {machineKind(machine) && <StatusPill>{machineKind(machine)}</StatusPill>}
    </>
  );
}

/** Agents using the computer the app runs on, or not: shown at once, saved by the app. */
export type Sharing = { sharing: boolean; setSharing: (on: boolean) => Promise<void> };

/** The switch that lets agents use this computer: it moves at once, and back if refused. */
export function SharingSwitch({ sharing, setSharing }: Sharing) {
  const [asked, setAsked] = useState<boolean>();

  return (
    <SwitchControl
      label="Let agents use this computer"
      checked={asked ?? sharing}
      onCheckedChange={(on) => {
        setAsked(on);
        // Refused, it moves back, and says why it did.
        void setSharing(on)
          .catch(() => toast.error('Could not change whether agents may use this computer.'))
          .finally(() => setAsked(undefined));
      }}
    />
  );
}

/**
 * One connected computer, a line: its name, whether it answers and whether it must be updated.
 * Everything else — how it stands, its release, updating it, its credentials, removing it — is
 * behind Configure. The computer the app runs on says so, and has its switch beside Configure;
 * the app keeps its credentials, so they are not offered here.
 */
export function MachineRow({
  api,
  machine,
  version,
  busy,
  onUpdated,
  onRotate,
  onRemove,
  ours,
}: {
  api: GatewayApi;
  machine: Machine;
  /** Given for the computer the app runs on. */
  ours?: Sharing | undefined;
  /** This gateway's release, when it has one. */
  version: string | undefined;
  /** Another action on the machines is running. */
  busy: boolean;
  onUpdated: () => Promise<unknown>;
  onRotate: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <span className="truncate">{machine.name}</span>
            {ours && <StatusPill>This computer</StatusPill>}
            <StatusPill tone={machine.online ? 'good' : 'quiet'}>
              {machine.online ? 'Online' : 'Offline'}
            </StatusPill>
            {machine.outdated && <StatusPill tone="bad">Update needed</StatusPill>}
            <span className="truncate text-xs text-muted">{machineKind(machine)}</span>
          </span>
        }
      >
        {ours && <SharingSwitch {...ours} />}
        <Action
          tone="outline"
          size="small"
          aria-label={`Configure ${machine.name}`}
          onClick={() => setOpen(true)}
        >
          Configure
        </Action>
      </SettingsRow>
      <Overlay open={open} onOpenChange={setOpen} title={machine.name} size="form">
        <MachineSettings
          api={api}
          machine={machine}
          version={version}
          busy={busy}
          onUpdated={onUpdated}
          onRotate={onRotate}
          onRemove={onRemove}
          managed={Boolean(ours)}
          close={() => setOpen(false)}
        />
      </Overlay>
    </>
  );
}

function MachineSettings({
  api,
  machine,
  version,
  busy,
  onUpdated,
  onRotate,
  onRemove,
  managed,
  close,
}: {
  api: GatewayApi;
  machine: Machine;
  version: string | undefined;
  busy: boolean;
  onUpdated: () => Promise<unknown>;
  onRotate: () => void;
  onRemove: () => void;
  /** The app keeps this one registered and its token: removing or rotating it is the app's. */
  managed: boolean;
  close: () => void;
}) {
  const update = useMachineUpdate(api, machine, onUpdated);
  const way = updateWay(machine, version);

  return (
    <div className="grid w-full gap-5 p-7">
      <header className="grid gap-2 pr-6">
        <h2 className="truncate text-lg font-semibold tracking-tight">{machine.name}</h2>
        <span className="flex flex-wrap items-center gap-1.5">
          <MachinePills machine={machine} version={version} />
        </span>
        <p className="text-sm leading-relaxed text-muted">
          {machineSummary(machine)}
          {machine.version && ` ${versionLine(machine, version)}`}
        </p>
      </header>
      {way === 'by-hand' && (
        <div className="grid gap-2">
          <p className="text-xs text-muted">
            It was not installed with npm, so it cannot update itself: run this on that computer.
          </p>
          <CopyCommand value="jian-remote update" label={`Copy the update for ${machine.name}`} />
        </div>
      )}
      {update.outcome && (
        <p
          role={update.outcome.ok ? 'status' : 'alert'}
          className={`text-sm ${update.outcome.ok ? 'text-ink' : 'text-bad'}`}
        >
          {update.outcome.message}
        </p>
      )}
      {update.error && (
        <p role="alert" className="text-sm text-bad">
          {update.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!managed && (
          <>
            <Action tone="danger" className="bg-bad/10" disabled={busy} onClick={onRemove}>
              Remove
            </Action>
            <Action
              tone="outline"
              aria-label={`Rotate credentials for ${machine.name}`}
              disabled={busy}
              onClick={onRotate}
            >
              <KeyRound size={14} />
              Rotate
            </Action>
          </>
        )}
        <span className="flex-1" />
        <Action tone="quiet" onClick={close}>
          Close
        </Action>
        {way === 'remote' && (
          <Action
            tone="primary"
            busy={update.busy}
            disabled={!machine.online}
            title={machine.online ? undefined : 'It updates once it is connected.'}
            onClick={() => void update.update()}
          >
            Update
          </Action>
        )}
      </div>
    </div>
  );
}
