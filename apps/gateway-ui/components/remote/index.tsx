'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Monitor, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { keys } from '@/lib/query/keys';
import type { GatewayApi } from '../../lib/api';
import { Avatar } from '../profile/avatar-field';
import {
  Badge,
  Button,
  Confirm,
  Empty,
  Field,
  IconButton,
  Modal,
  ResourceRow,
  SectionHeading,
} from '../ui';
import { Select } from '../ui/select';

type Props = { api: GatewayApi };
type Machine = Awaited<ReturnType<GatewayApi['remoteMachines']>>[number];
type Profile = Awaited<ReturnType<GatewayApi['profiles']>>[number];

/** Same agent picker as MCP import, with multiselect for who may run commands. */
function ProfileAllowList({
  profiles,
  selected,
  onChange,
  empty,
  id,
  'aria-describedby': describedBy,
}: {
  profiles: Profile[];
  selected: string[];
  onChange: (next: string[]) => void;
  empty: string;
  id?: string;
  'aria-describedby'?: string;
}) {
  if (profiles.length === 0) {
    return <p className="note text-muted">{empty}</p>;
  }

  return (
    <Select
      id={id}
      aria-describedby={describedBy}
      // When Field supplies `id`, its label is the accessible name; otherwise say what this is.
      aria-label={id ? undefined : 'Authorized agents'}
      multiple
      value={selected}
      onValueChange={onChange}
      placeholder="No agents authorized"
      searchThreshold={5}
      options={profiles.map((item) => ({
        value: item.id,
        label: item.name,
        icon: <Avatar name={item.name} avatar={item.avatar} className="mini-avatar" />,
      }))}
    />
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
        <IconButton
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
        </IconButton>
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
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [allowed, setAllowed] = useState<string[]>([]);
  const [reveal, setReveal] = useState<{
    id: string;
    name: string;
    token: string;
    kind: 'created' | 'rotated';
  } | null>(null);
  // Access the owner changed and has not saved yet, per machine. Kept apart from the list, so a
  // poll that brings the gateway's answer never undoes a choice still being made.
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [openId, setOpenId] = useState<string>();
  const [removing, setRemoving] = useState<Machine>();
  const [rotating, setRotating] = useState<Machine>();
  const [gatewayOrigin, setGatewayOrigin] = useState('https://YOUR-JIAN-GATEWAY');

  // Worker presence is polled by the gateway; the list is read again so Online/Offline follows
  // without a reload — faster while the install or rotate modal is open, since someone is
  // connecting a machine right now. A failed poll keeps the last good list.
  const list = useQuery({
    queryKey: keys.remoteMachines,
    queryFn: () => api.remoteMachines(),
    refetchInterval: reveal ? 2000 : 5000,
  });
  const machines = list.data ?? [];
  const loading = list.isPending;
  const loadError = list.data ? '' : list.error ? 'Could not load remote machines.' : '';
  const { data: profiles = [] } = useQuery({
    queryKey: keys.profiles,
    queryFn: () => api.profiles(),
  });
  // The npm dist-tag matching this gateway's release; @latest on a dev build or without notes.
  const { data: releases } = useQuery({
    queryKey: keys.releases,
    queryFn: () => api.releases(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const version = releases?.version?.trim();
  const packageTag =
    version && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ? version : 'latest';
  const accessOf = (machine: Machine) => edits[machine.id] ?? machine.allowedProfileIds;
  const refresh = () => client.invalidateQueries({ queryKey: keys.remoteMachines });

  useEffect(() => {
    setGatewayOrigin(window.location.origin);
  }, []);

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
      setReveal({ id: response.id, name: label, token: response.token, kind: 'created' });
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
      const machine = machines.find((item) => item.id === machineId);
      await api.setRemoteMachineAccess(machineId, machine ? accessOf(machine) : []);
      await refresh();
      setEdits(({ [machineId]: _saved, ...rest }) => rest);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update access.');
    } finally {
      setBusy(false);
    }
  }

  async function rotateCredentials(machine: Machine) {
    setBusy(true);
    setError('');
    try {
      const response = await api.rotateRemoteMachineCredentials(machine.id);
      setRotating(undefined);
      setReveal({
        id: response.id,
        name: response.name,
        token: response.token,
        kind: 'rotated',
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not rotate credentials.');
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

  const packageRef = `@jian-ai/remote-control@${packageTag}`;
  const installFlags = reveal
    ? `install --gateway '${gatewayOrigin}' --machine '${reveal.id}' --token '${reveal.token}'`
    : '';
  const configureFlags = reveal
    ? `configure --gateway '${gatewayOrigin}' --token '${reveal.token}'`
    : '';
  // Same npm one-liner on every OS once Node.js 24+ is installed.
  const npxInstall = reveal ? `npx --yes ${packageRef} ${installFlags}` : '';
  const globalInstall = reveal ? `npm install -g ${packageRef} && jian-remote ${installFlags}` : '';
  const npxConfigure = reveal ? `npx --yes ${packageRef} ${configureFlags}` : '';
  const globalConfigure = reveal ? `jian-remote ${configureFlags}` : '';
  const updateCommand = `npx --yes ${packageRef} update`;

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
      {(error || loadError) && (
        <p className="form-error" role="alert">
          {error || loadError}
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
          Register a computer, then run the npm/npx installer the panel shows — it embeds the
          gateway URL, machine id, and token. No clone of Jian is required.
        </Empty>
      ) : (
        <div className="resource-list">
          {machines.map((machine) => {
            const authorized = accessOf(machine);
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
                    {machine.online && machine.uiState === 'locked' && (
                      <Badge tone="warn" dot={false}>
                        Locked
                      </Badge>
                    )}
                    {machine.online && machine.uiState === 'display_asleep' && (
                      <Badge tone="neutral" dot={false}>
                        Display asleep
                      </Badge>
                    )}
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
                  <IconButton
                    aria-label={`Remove ${machine.name}`}
                    disabled={busy}
                    onClick={() => setRemoving(machine)}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                }
              >
                <div className="connection-form">
                  <Field
                    label="Agents allowed to execute commands"
                    hint="Only these agents may run shell commands on this computer. Leave empty for none."
                  >
                    <ProfileAllowList
                      profiles={profiles}
                      selected={authorized}
                      onChange={(next) =>
                        setEdits((current) => ({ ...current, [machine.id]: next }))
                      }
                      empty="Create an agent before granting access."
                    />
                  </Field>
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
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setRotating(machine)}
                    >
                      Rotate credentials
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
          description="Name the computer, then choose which agents may run commands on it."
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
                placeholder="e.g. Maya's Windows PC"
              />
            </Field>
            <Field
              label="Agents allowed to execute commands"
              hint="Leave empty to create the machine with no access. You can change this later."
            >
              <ProfileAllowList
                profiles={profiles}
                selected={allowed}
                onChange={setAllowed}
                empty="No agents yet. You can still create the machine and grant access later."
              />
            </Field>
          </form>
        </Modal>
      )}

      {reveal && (
        <Modal
          title={
            reveal.kind === 'rotated'
              ? `Credentials rotated for ${reveal.name}`
              : `${reveal.name} created`
          }
          description={
            reveal.kind === 'rotated'
              ? 'The previous worker token no longer works. Run configure on the computer (or install if it was never set up). The new token is shown only once.'
              : 'Run one of these installers on the computer. Each installs @jian-ai/remote-control from npm and connects it. The token is shown only once.'
          }
          close={() => setReveal(null)}
          footer={<Button onClick={() => setReveal(null)}>Done</Button>}
        >
          <div className="remote-created">
            {reveal.kind === 'rotated' ? (
              <>
                <CopyBlock
                  label="Already installed (npx configure)"
                  value={npxConfigure}
                  ariaLabel="Copy npx configure command"
                />
                <CopyBlock
                  label="Already installed (jian-remote configure)"
                  value={globalConfigure}
                  ariaLabel="Copy jian-remote configure command"
                />
                <CopyBlock
                  label="Fresh install (npx)"
                  value={npxInstall}
                  ariaLabel="Copy npx install command"
                />
              </>
            ) : (
              <>
                <CopyBlock
                  label="Any OS (npx)"
                  value={npxInstall}
                  ariaLabel="Copy npx install command"
                />
                <CopyBlock
                  label="Global install"
                  value={globalInstall}
                  ariaLabel="Copy global npm install command"
                />
                <CopyBlock
                  label="Later: update worker"
                  value={updateCommand}
                  ariaLabel="Copy update command"
                />
              </>
            )}
            <CopyBlock
              label="Worker token only"
              value={reveal.token}
              ariaLabel="Copy worker token"
            />
            <p className="note">
              {reveal.kind === 'rotated'
                ? 'Needs Node.js 24+ on the computer. Prefer configure when the worker is already installed — it rewrites ~/.config/jian-remote and restarts the service without wiping the LaunchAgent. The command includes the new token; clear shell history if you share that terminal. The old token stops working immediately.'
                : 'Needs Node.js 24+ on the computer. The install command includes the worker token — run it once, then clear shell history if you share that terminal. Later upgrades use update (reads ~/.config/jian-remote; no token again) and must share the gateway’s major.minor version. To change only the token or gateway URL later, use configure or Rotate credentials in this panel. The gateway must be reachable over HTTPS from the computer. After install, the worker starts on login (Windows Task Scheduler ONLOGON, macOS LaunchAgent, or Linux systemd --user), so a reboot brings it back when that user signs in. If Online stays red, run update, restart the local service, or check ~/.config/jian-remote/worker.log. This list refreshes Online status every few seconds while the page is open.'}
            </p>
          </div>
        </Modal>
      )}

      {rotating && (
        <Confirm
          title={`Rotate credentials for ${rotating.name}?`}
          description="Issues a new worker token and invalidates the current one. The machine stays registered; run configure on that computer with the new token."
          busy={busy}
          close={() => setRotating(undefined)}
          confirm={() => void rotateCredentials(rotating)}
        />
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
