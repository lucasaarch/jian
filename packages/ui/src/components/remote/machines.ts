'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { gatewayOrigin as configuredOrigin } from '../../platform/gateway';

/**
 * Remote machines as every screen of them reads and changes them: the list, the release the
 * workers should run, and the one install command. The web panel and the desktop settings draw
 * them differently on top of this.
 */

export type Machine = Awaited<ReturnType<GatewayApi['remoteMachines']>>[number];
type Outcome = Awaited<ReturnType<GatewayApi['updateRemoteMachine']>>;

/** A worker token, shown once: just after the machine is created or its credentials rotated. */
export type Reveal = { id: string; name: string; token: string; kind: 'created' | 'rotated' };

/** Whether the machine runs another release than this gateway, which may have none. */
export function behind(machine: Machine, gatewayVersion: string | undefined): boolean {
  return Boolean(machine.version && gatewayVersion && machine.version !== gatewayVersion);
}

/**
 * How a machine is brought level with this gateway: `remote`, its worker updates itself because
 * npm installed it; `by-hand`, the owner runs the update on that computer; `none`, nothing to do
 * or nothing known yet.
 */
export function updateWay(
  machine: Machine,
  gatewayVersion: string | undefined,
): 'remote' | 'by-hand' | 'none' {
  if (!machine.version) return 'none';
  const offer = machine.outdated || behind(machine, gatewayVersion) || !gatewayVersion;
  if (offer && machine.updatable) return 'remote';
  if (!machine.updatable && behind(machine, gatewayVersion)) return 'by-hand';
  return 'none';
}

/** The release a machine runs against this gateway's, in a sentence. */
export const versionLine = (machine: Machine, gatewayVersion: string | undefined) =>
  `Worker ${machine.version}${gatewayVersion ? `, this gateway ${gatewayVersion}` : ''}.`;

/** How the machine stands for the agents, in a sentence. */
const systems: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

/**
 * What the machine is, as a person names it: its system with the version its worker reported,
 * or the system's name alone until it has, and its architecture — "macOS 27.2 · arm64". Empty
 * for a machine that has never said.
 */
export function machineKind(machine: Pick<Machine, 'platform' | 'system'>): string {
  const [os = '', arch = ''] = machine.platform === 'unknown' ? [] : machine.platform.split('-');
  return [machine.system ?? systems[os], arch].filter(Boolean).join(' · ');
}

export function machineSummary(machine: Machine): string {
  // Whether it answers comes first: a machine away is not "connected", whatever its release.
  if (!machine.online) return 'Not connected. Run the install command on it, or start its worker.';
  if (machine.outdated) {
    return 'Connected, on another release than this gateway. Update it so agents can use it.';
  }
  return 'Connected. Every agent can use it.';
}

/** The npm dist-tag matching this gateway's release; `latest` on a dev build or without notes. */
function packageTag(version: string | undefined): string {
  return version && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ? version : 'latest';
}

/**
 * One command, the same on every OS once Node.js 24+ is there, and the same after a rotation:
 * it installs jian-remote, or brings it up to date, and connects it with these credentials.
 * Rotating is also how a lost command is had again, so it never assumes the worker is there.
 */
function installCommand(reveal: Reveal, gatewayOrigin: string, tag: string): string {
  return `npm install -g @jian-ai/remote-control@${tag} && jian-remote install --gateway '${gatewayOrigin}' --machine '${reveal.id}' --token '${reveal.token}'`;
}

const failure = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

/**
 * The machines and what is done to them. Each action resolves to whether it worked; a failure
 * is kept in `error` for the screen to say.
 */
export function useRemoteMachines(api: GatewayApi) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [gatewayOrigin, setGatewayOrigin] = useState('https://YOUR-JIAN-GATEWAY');

  // Worker presence is polled by the gateway; the list is read again so Online/Offline follows
  // without a reload — faster while an install command is shown, since someone is connecting a
  // machine right now. A failed poll keeps the last good list.
  const list = useQuery({
    queryKey: keys.remoteMachines,
    queryFn: () => api.remoteMachines(),
    refetchInterval: reveal ? 2000 : 5000,
  });
  const { data: releases } = useQuery({
    queryKey: keys.releases,
    queryFn: () => api.releases(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const version = releases?.version?.trim();
  const refresh = () => client.invalidateQueries({ queryKey: keys.remoteMachines });

  // The origin is read from `window`, which a server render does not have.
  useEffect(() => {
    setGatewayOrigin(configuredOrigin());
  }, []);

  const attempt = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
      return true;
    } catch (cause) {
      setError(failure(cause, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    machines: list.data ?? [],
    loading: list.isPending,
    loadError: list.data ? '' : list.error ? 'Could not load remote machines.' : '',
    /** This gateway's release, when it has one. */
    version,
    busy,
    error,
    reveal,
    closeReveal: () => setReveal(null),
    command: reveal ? installCommand(reveal, gatewayOrigin, packageTag(version)) : '',
    refresh,
    create: (name: string) =>
      attempt(async () => {
        const label = name.trim();
        const response = await api.createRemoteMachine({ name: label });
        setReveal({ id: response.id, name: label, token: response.token, kind: 'created' });
      }, 'Could not create machine.'),
    rotate: (machine: Machine) =>
      attempt(async () => {
        const response = await api.rotateRemoteMachineCredentials(machine.id);
        setReveal({ id: response.id, name: response.name, token: response.token, kind: 'rotated' });
      }, 'Could not rotate credentials.'),
    remove: (machine: Machine) =>
      attempt(() => api.deleteRemoteMachine(machine.id), 'Could not remove machine.'),
  };
}

/** Asks one machine's worker to update itself, and keeps what it answered. */
export function useMachineUpdate(
  api: GatewayApi,
  machine: Machine,
  onUpdated: () => Promise<unknown>,
) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const [error, setError] = useState('');

  async function update() {
    setBusy(true);
    setError('');
    setOutcome(undefined);
    try {
      setOutcome(await api.updateRemoteMachine(machine.id));
      await onUpdated();
    } catch (cause) {
      setError(failure(cause, 'Could not update the machine.'));
    } finally {
      setBusy(false);
    }
  }

  return { busy, outcome, error, update };
}
