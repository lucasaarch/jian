'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { type Machine, useRemoteMachines } from '../../components/remote/machines';
import { Action, ConfirmDialog, SettingsGroup, SettingsRow, StatusPill } from '../../kit';
import { useActions } from '../../lib/workspace';
import { AddMachine, RevealCommand, RotateCredentials } from './remote-dialogs';
import { MachineRow, type Sharing, SharingSwitch } from './remote-machine-row';

/**
 * The computer an app runs on, as that app knows it: its machine on this gateway once the app
 * registered it, and whether agents may use it. Given only by a host that is such an app.
 */
export type ThisComputer = Sharing & { machineId: string | null };

/**
 * The computers connected to this gateway, which every agent can run commands on and use the
 * screen of: how each stands, its update, its credentials to rotate and the machine to remove,
 * and one more to register, with the command that installs and connects its worker.
 */
export function MachinesPage({ thisComputer }: { thisComputer?: ThisComputer | undefined }) {
  const { api } = useActions();
  const remote = useRemoteMachines(api);
  const [adding, setAdding] = useState(false);
  // The machine asked about stays named while its dialog fades out.
  const [target, setTarget] = useState<Machine>();
  const [asking, setAsking] = useState<'rotate' | 'remove'>();

  const ask = (machine: Machine, what: 'rotate' | 'remove') => {
    setTarget(machine);
    setAsking(what);
  };
  const close = (open: boolean) => !open && setAsking(undefined);
  // A failure closes the dialog too, and is said above the list, where it stays.
  const answer = async (action: (machine: Machine) => Promise<boolean>) => {
    if (target) await action(target);
    setAsking(undefined);
  };

  const ours = thisComputer?.machineId
    ? remote.machines.find((machine) => machine.id === thisComputer.machineId)
    : undefined;
  // This computer first, then the others as the gateway lists them.
  const machines = ours
    ? [ours, ...remote.machines.filter((machine) => machine !== ours)]
    : remote.machines;

  const failure = remote.loadError || (adding ? '' : remote.error);
  const note = failure ? (
    <span role="alert" className="text-bad">
      {failure}
    </span>
  ) : remote.loading ? (
    'Loading…'
  ) : remote.machines.length === 0 && !thisComputer ? (
    'None yet'
  ) : undefined;

  return (
    <>
      <SettingsGroup title="Machines" note={note}>
        {thisComputer && !ours && (
          // Not on this gateway yet: the app registers it as soon as it can, or does not while off.
          <SettingsRow
            title={
              <span className="flex items-center gap-2">
                This computer
                {thisComputer.sharing && <StatusPill>Connecting</StatusPill>}
              </span>
            }
          >
            <SharingSwitch sharing={thisComputer.sharing} setSharing={thisComputer.setSharing} />
          </SettingsRow>
        )}
        {machines.map((machine) => (
          <MachineRow
            key={machine.id}
            api={api}
            machine={machine}
            ours={machine === ours ? thisComputer : undefined}
            version={remote.version}
            busy={remote.busy}
            onUpdated={remote.refresh}
            onRotate={() => ask(machine, 'rotate')}
            onRemove={() => ask(machine, 'remove')}
          />
        ))}
        <SettingsRow title="Add a machine">
          <Action tone="outline" size="small" onClick={() => setAdding(true)}>
            <Plus size={13} />
            Add
          </Action>
        </SettingsRow>
      </SettingsGroup>
      <AddMachine
        open={adding}
        onOpenChange={setAdding}
        create={remote.create}
        busy={remote.busy}
        error={remote.error}
      />
      <RevealCommand reveal={remote.reveal} command={remote.command} onClose={remote.closeReveal} />
      <RotateCredentials
        machine={target}
        open={asking === 'rotate'}
        onOpenChange={close}
        rotate={() => void answer(remote.rotate)}
        busy={remote.busy}
      />
      <ConfirmDialog
        open={asking === 'remove'}
        onOpenChange={close}
        title={`Remove ${target?.name ?? ''}?`}
        phrase={target?.name ?? ''}
        action="Remove machine"
        busy={remote.busy}
        run={() => void answer(remote.remove)}
      >
        Its worker token stops working at once. Remove the local worker service on that computer
        afterwards. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
