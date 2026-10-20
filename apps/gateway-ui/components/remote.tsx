'use client';

import { Copy, Monitor, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { GatewayApi } from '../lib/api';
import { Button } from './ui/button';

type Props = { api: GatewayApi };
type Machine = Awaited<ReturnType<GatewayApi['remoteMachines']>>[number];
type Profile = Awaited<ReturnType<GatewayApi['profiles']>>[number];

export function RemoteMachines({ api }: Props) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [allowed, setAllowed] = useState<string[]>([]);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  const [access, setAccess] = useState<Record<string, string[]>>({});
  const [gatewayOrigin, setGatewayOrigin] = useState('https://YOUR-JIAN-GATEWAY');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextMachines, nextProfiles] = await Promise.all([
        api.remoteMachines(),
        api.profiles(),
      ]);
      setMachines(nextMachines);
      setProfiles(nextProfiles);
      setAccess(
        Object.fromEntries(nextMachines.map((machine) => [machine.id, machine.allowedProfileIds])),
      );
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load remote machines.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    setGatewayOrigin(window.location.origin);
    void refresh();
  }, [refresh]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await api.createRemoteMachine({
        name: name.trim(),
        allowedProfileIds: allowed,
      });
      setCreated({ id: response.id, token: response.token });
      setName('');
      setAllowed([]);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create machine.');
    } finally {
      setBusy(false);
    }
  }

  async function saveAccess(machineId: string) {
    setBusy(true);
    setError('');
    try {
      await api.setRemoteMachineAccess(machineId, access[machineId] ?? []);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update access.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(machine: Machine) {
    if (!window.confirm(`Remove ${machine.name}? Its worker token will stop working.`)) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteRemoteMachine(machine.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove machine.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError('Clipboard access is unavailable; select and copy the text manually.');
    }
  }

  const profileOptions = (selected: string[], change: (next: string[]) => void) => (
    <div className="grid gap-2 sm:grid-cols-2">
      {profiles.map((profile) => (
        <label key={profile.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={selected.includes(profile.id)}
            onChange={(event) =>
              change(
                event.target.checked
                  ? [...selected, profile.id]
                  : selected.filter((id) => id !== profile.id),
              )
            }
          />
          {profile.name} <span className="text-muted-foreground">({profile.id.slice(0, 8)})</span>
        </label>
      ))}
    </div>
  );

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Monitor /> Jian Remote
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect your computers and choose which profiles can run commands on each one.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </header>
      {error && (
        <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {created && (
        <div className="space-y-3 border-primary p-5">
          <h2 className="font-semibold">Machine created — save this worker token now</h2>
          <p className="text-sm">
            It is shown only once. Install the worker on the computer, then remove this token from
            any clipboard or notes.
          </p>
          <div className="flex gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted p-3 text-xs">
              {created.token}
            </code>
            <Button
              variant="secondary"
              onClick={() => void copy(created.token)}
              aria-label="Copy worker token"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-sm">
            Windows (PowerShell; run where <code>jian-remote.mjs</code> was downloaded):
          </p>
          <div className="flex gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted p-3 text-xs">
              node .\jian-remote.mjs install --gateway {gatewayOrigin} --machine {created.id}{' '}
              --token-prompt
            </code>
            <Button
              variant="secondary"
              onClick={() =>
                void copy(
                  `node .\\jian-remote.mjs install --gateway ${gatewayOrigin} --machine ${created.id} --token-prompt`,
                )
              }
              aria-label="Copy Windows install command"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            For macOS/Linux, run the same installer with <code>--token-prompt</code>; the downloaded
            script must come from this Jian release.
          </p>
          <Button variant="secondary" onClick={() => setCreated(null)}>
            Done
          </Button>
        </div>
      )}
      <div className="space-y-4 p-5">
        <h2 className="flex items-center gap-2 font-semibold">
          <Plus className="h-4 w-4" />
          Add a machine
        </h2>
        <form className="space-y-4" onSubmit={create}>
          <label className="block text-sm">
            Machine name
            <input
              className="mt-1 w-full rounded border bg-background p-2"
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Lucas's Windows PC"
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Profiles allowed to execute commands</legend>
            {profileOptions(allowed, setAllowed)}
          </fieldset>
          <Button type="submit" disabled={busy || !name.trim()}>
            Create machine
          </Button>
        </form>
      </div>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Connected machines</h2>
        {loading ? (
          <p>Loading…</p>
        ) : machines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No machines registered yet.</p>
        ) : (
          machines.map((machine) => (
            <div key={machine.id} className="space-y-4 p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold">{machine.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {machine.platform ?? 'Not connected'} · {machine.online ? 'Online' : 'Offline'}
                  </p>
                </div>
                <Button variant="danger" disabled={busy} onClick={() => void remove(machine)}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Remove
                </Button>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Authorized profiles</legend>
                {profileOptions(access[machine.id] ?? [], (next) =>
                  setAccess((current) => ({ ...current, [machine.id]: next })),
                )}
              </fieldset>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void saveAccess(machine.id)}
              >
                Save access
              </Button>
            </div>
          ))
        )}
      </section>
    </main>
  );
}
