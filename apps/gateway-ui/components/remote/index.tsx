'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Monitor, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { keys } from '@/lib/query/keys';
import type { GatewayApi } from '../../lib/api';
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

type Props = { api: GatewayApi };
type Machine = Awaited<ReturnType<GatewayApi['remoteMachines']>>[number];

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
  const [reveal, setReveal] = useState<{
    id: string;
    name: string;
    token: string;
    kind: 'created' | 'rotated';
  } | null>(null);
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
      const response = await api.createRemoteMachine({ name: label });
      setReveal({ id: response.id, name: label, token: response.token, kind: 'created' });
      setName('');
      setCreating(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create machine.');
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
  // One command per situation, the same on every OS once Node.js 24+ is there: a new machine
  // installs jian-remote and connects it; a rotated one already has it and takes the new token.
  const command = !reveal
    ? ''
    : reveal.kind === 'created'
      ? `npm install -g ${packageRef} && jian-remote install --gateway '${gatewayOrigin}' --machine '${reveal.id}' --token '${reveal.token}'`
      : `jian-remote configure --gateway '${gatewayOrigin}' --token '${reveal.token}'`;

  return (
    <>
      <SectionHeading
        title="Remote Control"
        description="Connect computers. Every agent can run commands and use the screen on each one."
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
          Register a computer, then run the one command the panel shows on it — it installs
          jian-remote and connects it to this gateway.
        </Empty>
      ) : (
        <div className="resource-list">
          {machines.map((machine) => {
            const open = openId === machine.id;

            return (
              <ResourceRow
                key={machine.id}
                id={`remote-machine-${machine.id}`}
                icon={<Monitor size={20} strokeWidth={1.6} />}
                name={machine.name}
                description={
                  machine.online
                    ? 'Connected. Every agent can use it.'
                    : 'Not connected. Run the install command on it, or start its worker.'
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
                action="Manage"
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
                  <div className="remote-access-actions">
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
          description="Name the computer. Every agent will be able to use it once it connects."
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
              ? 'The previous worker token no longer works. Run this on the computer; the token is shown only once.'
              : 'Run this on the computer. It installs jian-remote and connects it; the token is shown only once.'
          }
          close={() => setReveal(null)}
          footer={<Button onClick={() => setReveal(null)}>Done</Button>}
        >
          <div className="remote-created">
            <CopyBlock
              label={reveal.kind === 'rotated' ? 'Run on the computer' : 'Install on the computer'}
              value={command}
              ariaLabel="Copy command"
            />
            <p className="note">
              {reveal.kind === 'rotated'
                ? 'The command includes the new token; clear shell history if you share that terminal. The old token stops working immediately.'
                : 'Needs Node.js 24+ on the computer and HTTPS access to this gateway. The command includes the worker token; clear shell history if you share that terminal. The worker starts again on login and keeps itself on this gateway’s version. If it stays offline, check ~/.config/jian-remote/worker.log.'}
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
