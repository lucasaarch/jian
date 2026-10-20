'use client';

import { Check, Copy, Monitor, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { GatewayApi } from '../../lib/api';
import { Badge, Button, Confirm, Empty, Field, Modal, ResourceRow, SectionHeading } from '../ui';

type Props = { api: GatewayApi };
type Machine = Awaited<ReturnType<GatewayApi['remoteMachines']>>[number];
type Profile = Awaited<ReturnType<GatewayApi['profiles']>>[number];

function toggleId(selected: string[], id: string, on: boolean) {
  return on ? [...selected, id] : selected.filter((item) => item !== id);
}

function ProfileAllowList({
  profiles,
  selected,
  onChange,
  empty,
}: {
  profiles: Profile[];
  selected: string[];
  onChange: (next: string[]) => void;
  empty: string;
}) {
  if (profiles.length === 0) {
    return <p className="note text-muted">{empty}</p>;
  }

  return (
    <fieldset className="profile-allow-list">
      <legend className="sr-only">Authorized profiles</legend>
      {profiles.map((profile) => (
        <label key={profile.id} className="check-row">
          <input
            type="checkbox"
            checked={selected.includes(profile.id)}
            onChange={(event) => onChange(toggleId(selected, profile.id, event.target.checked))}
          />
          <span>
            <strong>{profile.name}</strong>
            <small>{profile.id}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function CopyBlock({
  label,
  value,
  ariaLabel,
}: {
  label: string;
  value: string;
  ariaLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  return (
    <div className="copy-block">
      <div className="copy-block-head">
        <span>{label}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={ariaLabel}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setError('');
              window.setTimeout(() => setCopied(false), 1500);
            } catch {
              setError('Select the text and copy it by hand.');
            }
          }}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      <textarea
        className="secret-value"
        aria-label={label}
        value={value}
        readOnly
        rows={3}
        spellCheck={false}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function RemoteMachines({ api }: Props) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [allowed, setAllowed] = useState<string[]>([]);
  const [created, setCreated] = useState<{ id: string; name: string; token: string } | null>(null);
  const [access, setAccess] = useState<Record<string, string[]>>({});
  const [openId, setOpenId] = useState<string>();
  const [removing, setRemoving] = useState<Machine>();
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
      const label = name.trim();
      const response = await api.createRemoteMachine({
        name: label,
        allowedProfileIds: allowed,
      });
      setCreated({ id: response.id, name: label, token: response.token });
      setName('');
      setAllowed([]);
      setCreating(false);
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
    setBusy(true);
    setError('');
    try {
      await api.deleteRemoteMachine(machine.id);
      if (openId === machine.id) setOpenId(undefined);
      setRemoving(undefined);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove machine.');
    } finally {
      setBusy(false);
    }
  }

  const scriptUrl = `${gatewayOrigin}/jian-remote.mjs`;
  const windowsInstall = created
    ? `$dir="$env:USERPROFILE\\.config\\jian-remote"; New-Item -ItemType Directory -Force -Path $dir | Out-Null; irm '${scriptUrl}' -OutFile "$dir\\jian-remote.mjs"; node "$dir\\jian-remote.mjs" install --gateway '${gatewayOrigin}' --machine '${created.id}' --token '${created.token}'`
    : '';
  const unixInstall = created
    ? `mkdir -p ~/.config/jian-remote && curl -fsS -o ~/.config/jian-remote/jian-remote.mjs '${scriptUrl}' && node ~/.config/jian-remote/jian-remote.mjs install --gateway '${gatewayOrigin}' --machine '${created.id}' --token '${created.token}'`
    : '';

  return (
    <>
      <SectionHeading
        title="Remote Control"
        description="Connect computers and choose which profiles can run commands on each one."
        action={
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus size={16} />
            Add machine
          </Button>
        }
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="note text-muted">Loading…</p>
      ) : machines.length === 0 ? (
        <Empty
          title="No machines yet"
          action={
            <Button type="button" onClick={() => setCreating(true)}>
              <Plus size={16} />
              Add machine
            </Button>
          }
        >
          Register a computer, then run the one-line installer the panel shows — it downloads the
          worker and connects it. No clone of Jian is required.
        </Empty>
      ) : (
        <div className="resource-list">
          {machines.map((machine) => {
            const authorized = access[machine.id] ?? [];
            const names = profiles
              .filter((profile) => authorized.includes(profile.id))
              .map((profile) => profile.name);
            const open = openId === machine.id;

            return (
              <ResourceRow
                key={machine.id}
                id={`remote-machine-${machine.id}`}
                icon={<Monitor size={20} strokeWidth={1.6} />}
                name={machine.name}
                description={
                  names.length
                    ? `Authorized: ${names.join(', ')}`
                    : 'No profiles authorized — commands cannot run yet.'
                }
                badges={
                  <>
                    <Badge tone={machine.online ? 'good' : 'neutral'}>
                      {machine.online ? 'Online' : 'Offline'}
                    </Badge>
                    {machine.platform !== 'unknown' && (
                      <Badge tone="neutral" dot={false}>
                        {machine.platform}
                      </Badge>
                    )}
                  </>
                }
                facts={[machine.id]}
                action="Access"
                open={open}
                busy={busy}
                onToggle={() => setOpenId(open ? undefined : machine.id)}
                actions={
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${machine.name}`}
                    disabled={busy}
                    onClick={() => setRemoving(machine)}
                  >
                    <Trash2 size={16} />
                  </button>
                }
              >
                <div className="connection-form">
                  <p className="note">
                    Only checked profiles may run shell commands on this computer. The default is
                    none.
                  </p>
                  <ProfileAllowList
                    profiles={profiles}
                    selected={authorized}
                    onChange={(next) =>
                      setAccess((current) => ({ ...current, [machine.id]: next }))
                    }
                    empty="Create a profile before granting access."
                  />
                  <div className="remote-access-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      busy={busy}
                      onClick={() => void saveAccess(machine.id)}
                    >
                      Save access
                    </Button>
                  </div>
                </div>
              </ResourceRow>
            );
          })}
        </div>
      )}

      {creating && (
        <Modal
          title="Add a machine"
          description="Name the computer, then choose which profiles may run commands on it."
          close={() => setCreating(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="create-remote-machine"
                busy={busy}
                disabled={!name.trim()}
              >
                Create machine
              </Button>
            </>
          }
        >
          <form id="create-remote-machine" className="connection-form" onSubmit={create}>
            <Field
              label="Machine name"
              hint="A label you will recognize, such as the owner and the OS."
            >
              <input
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Lucas's Windows PC"
              />
            </Field>
            <fieldset className="profile-allow-fieldset">
              <legend>Profiles allowed to execute commands</legend>
              <ProfileAllowList
                profiles={profiles}
                selected={allowed}
                onChange={setAllowed}
                empty="No profiles yet. You can still create the machine and grant access later."
              />
              <small>Leave every profile unchecked to create a machine with no access.</small>
            </fieldset>
          </form>
        </Modal>
      )}

      {created && (
        <Modal
          title={`${created.name} created`}
          description="Run one of these installers on the computer. Each downloads the worker from this gateway and connects it. The token is shown only once."
          close={() => setCreated(null)}
          footer={<Button onClick={() => setCreated(null)}>Done</Button>}
        >
          <div className="remote-created">
            <CopyBlock
              label="Windows (PowerShell)"
              value={windowsInstall}
              ariaLabel="Copy Windows install command"
            />
            <CopyBlock
              label="macOS / Linux"
              value={unixInstall}
              ariaLabel="Copy macOS or Linux install command"
            />
            <CopyBlock
              label="Worker token only"
              value={created.token}
              ariaLabel="Copy worker token"
            />
            <p className="note">
              Needs Node.js 24+ on the computer. The command includes the worker token — run it
              once, then clear shell history if you share that terminal. The gateway must be
              reachable over HTTPS from the computer.
            </p>
          </div>
        </Modal>
      )}

      {removing && (
        <Confirm
          title={`Remove ${removing.name}?`}
          description="Its worker token will stop working. Remove the local worker service on that computer afterwards."
          busy={busy}
          close={() => setRemoving(undefined)}
          confirm={() => void remove(removing)}
        />
      )}
    </>
  );
}
