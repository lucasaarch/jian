'use client';

import { useState } from 'react';
import type { GatewayApi } from '../../lib/api';
import { Button } from '../ui';

type Machine = Awaited<ReturnType<GatewayApi['remoteMachines']>>[number];
type Outcome = Awaited<ReturnType<GatewayApi['updateRemoteMachine']>>;

/** Whether the machine runs another release than this gateway, which may have none. */
export function behind(machine: Machine, gatewayVersion: string | undefined): boolean {
  return Boolean(machine.version && gatewayVersion && machine.version !== gatewayVersion);
}

/**
 * The release a machine runs against this gateway's, and the way to bring it level: its worker
 * updates itself when npm installed it; otherwise the owner runs the update on that computer.
 */
export function MachineUpdate({
  api,
  machine,
  gatewayVersion,
  onUpdated,
}: {
  api: GatewayApi;
  machine: Machine;
  gatewayVersion: string | undefined;
  onUpdated: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const [error, setError] = useState('');

  if (!machine.version) return null;
  const offer = machine.outdated || behind(machine, gatewayVersion) || !gatewayVersion;

  async function update() {
    setBusy(true);
    setError('');
    setOutcome(undefined);
    try {
      setOutcome(await api.updateRemoteMachine(machine.id));
      await onUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the machine.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <p className="note">
        Jian Remote {machine.version}
        {gatewayVersion ? `, this gateway ${gatewayVersion}` : ''}.
        {machine.outdated && ' Agents cannot use it until it is updated.'}
      </p>
      {offer && machine.updatable && (
        <div className="remote-access-actions">
          <Button
            type="button"
            variant="secondary"
            busy={busy}
            disabled={busy || !machine.online}
            onClick={() => void update()}
          >
            Update
          </Button>
        </div>
      )}
      {offer && !machine.updatable && behind(machine, gatewayVersion) && (
        <p className="note">
          It was not installed with npm, so it cannot update itself. On that computer, run{' '}
          <code>jian-remote update</code>.
        </p>
      )}
      {outcome && (
        <p className={outcome.ok ? 'note' : 'form-error'} role={outcome.ok ? 'status' : 'alert'}>
          {outcome.message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
