'use client';

import { Check, Copy, Monitor, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { GatewayApi } from '../../lib/api';
import { Avatar } from '../profile/avatar-field';
import { Badge, Button, Confirm, Empty, Field, Modal, ResourceRow, SectionHeading } from '../ui';
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
  /** npm dist-tag or exact version matching this gateway release when known. */
  const [packageTag, setPackageTag] = useState('latest');

  const refresh = useCallback(
    async (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true);
      try {
        const [nextMachines, nextProfiles] = await Promise.all([
          api.remoteMachines(),
          api.profiles(),
        ]);
        setMachines(nextMachines);
        setProfiles(nextProfiles);
        setAccess(
          Object.fromEntries(
            nextMachines.map((machine) => [machine.id, machine.allowedProfileIds]),
          ),
        );
        setError('');
      } catch (cause) {
        // Quiet polls keep the last good list; only surface errors on an explicit load.
        if (!opts?.quiet) {
          setError(cause instanceof Error ? cause.message : 'Could not load remote machines.');
        }
      } finally {
        if (!opts?.quiet) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    setGatewayOrigin(window.location.origin);
    void refresh();
    void api
      .releases()
      .then((releases) => {
        const version = releases.version?.trim();
        // Dev builds have no version; pin published installs to the running release.
        if (version && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
          setPackageTag(version);
        }
      })
      .catch(() => {
        // Keep @latest when the releases endpoint is unavailable.
      });
  }, [api, refresh]);

  // Worker presence is polled by the gateway; refresh Online/Offline without a manual reload.
  // Faster while the install modal is open (someone is connecting a machine right now).
  useEffect(() => {
    const ms = created ? 2000 : 5000;
    const timer = window.setInterval(() => void refresh({ quiet: true }), ms);
    return () => window.clearInterval(timer);
  }, [created, refresh]);

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

  const packageRef = `@jian-ai/remote-control@${packageTag}`;
  const installFlags = created
    ? `install --gateway '${gatewayOrigin}' --machine '${created.id}' --token '${created.token}'`
    : '';
  // Same npm one-liner on every OS once Node.js 24+ is installed.
  const npxInstall = created ? `npx --yes ${packageRef} ${installFlags}` : '';
  const globalInstall = created
    ? `npm install -g ${packageRef} && jian-remote ${installFlags}`
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
          Register a computer, then run the npm/npx installer the panel shows — it embeds the
          gateway URL, machine id, and token. No clone of Jian is required.
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
                  <Field
                    label="Agents allowed to execute commands"
                    hint="Only these agents may run shell commands on this computer. Leave empty for none."
                  >
                    <ProfileAllowList
                      profiles={profiles}
                      selected={authorized}
                      onChange={(next) =>
                        setAccess((current) => ({ ...current, [machine.id]: next }))
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
                placeholder="e.g. Lucas's Windows PC"
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

      {created && (
        <Modal
          title={`${created.name} created`}
          description="Run one of these installers on the computer. Each installs @jian-ai/remote-control from npm and connects it. The token is shown only once."
          close={() => setCreated(null)}
          footer={<Button onClick={() => setCreated(null)}>Done</Button>}
        >
          <div className="remote-created">
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
              label="Worker token only"
              value={created.token}
              ariaLabel="Copy worker token"
            />
            <p className="note">
              Needs Node.js 24+ on the computer. The command includes the worker token — run it
              once, then clear shell history if you share that terminal. The gateway must be
              reachable over HTTPS from the computer. After install, the worker starts on login
              (Windows Task Scheduler ONLOGON, macOS LaunchAgent, or Linux systemd --user), so a
              reboot brings it back when that user signs in. If Online stays red, restart the local
              service or re-run install and check ~/.config/jian-remote/worker.log. This list
              refreshes Online status every few seconds while the page is open.
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
