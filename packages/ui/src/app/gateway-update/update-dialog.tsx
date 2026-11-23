'use client';

import type { UpdateStatus } from '@jian/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { Action, CheckBox, Overlay, OverlayActions, Progress } from '../../kit';
import { reloadApp } from '../reload';
import { ReleaseDetails } from '../updates/release-details';
import { releaseUrl, updateStatus } from './query';
import { runUpdate, type UpdatePhase, useGatewayUpdate } from './store';

/**
 * The one dialog that updates a server installation, from Settings or the command palette: the
 * release and its notes, the backup it asks for when it does, then the wait for the gateway to
 * come back on it. Mounted once, beside the app.
 */
export function GatewayUpdateDialog() {
  const open = useGatewayUpdate((state) => state.open);
  const setOpen = useGatewayUpdate((state) => state.setOpen);
  const phase = useGatewayUpdate((state) => state.phase);
  const status = useQuery({ ...updateStatus(), enabled: open }).data;

  return (
    <Overlay open={open} onOpenChange={setOpen} title="Update Jian" size="form">
      {phase.step === 'idle' ? (
        status?.latest ? (
          <Ask status={status} latest={status.latest} close={() => setOpen(false)} />
        ) : (
          <Said title="Jian is up to date" close={() => setOpen(false)}>
            {status?.current ? `${status.current} is the newest release.` : 'No newer release.'}
          </Said>
        )
      ) : (
        <Progressing phase={phase} close={() => setOpen(false)} />
      )}
    </Overlay>
  );
}

function Ask({
  status,
  latest,
  close,
}: {
  status: UpdateStatus;
  latest: NonNullable<UpdateStatus['latest']>;
  close: () => void;
}) {
  const client = useQueryClient();
  const [backedUp, setBackedUp] = useState(false);
  const parts =
    status.method === 'sidecar'
      ? 'The compose updater pulls the gateway and web images of this release and restarts them.'
      : status.webhooks.web
        ? 'Jian calls the web’s redeploy webhook, then the gateway’s.'
        : 'Jian calls the gateway’s redeploy webhook.';

  return (
    <form
      className="grid w-full gap-5 p-7"
      onSubmit={(event) => {
        event.preventDefault();
        void runUpdate(client, latest.version, backedUp);
      }}
    >
      <header className="grid gap-1.5 pr-10">
        <h2 className="text-lg font-semibold tracking-tight">Update to Jian {latest.version}</h2>
        <p className="text-sm leading-relaxed text-muted">
          {status.current ? `This gateway runs ${status.current}. ` : ''}
          {parts} The panel reconnects once it is back.
        </p>
      </header>
      <ReleaseDetails
        release={{
          version: latest.version,
          summary: '',
          notes: latest.body,
          url: releaseUrl(latest.version),
          newLine: false,
        }}
      />
      {status.backup && (
        <div className="grid gap-3 rounded-xl bg-warn-soft px-3 py-2.5 text-[13px] leading-snug text-warn">
          <p>
            A release on the way changes the database in a way that cannot be undone. Back up
            PostgreSQL before you update.
          </p>
          <span className="flex items-center gap-2 text-ink">
            <CheckBox
              checked={backedUp}
              onCheckedChange={setBackedUp}
              label="I backed up the database"
            />
            <span aria-hidden="true">I backed up the database</span>
          </span>
        </div>
      )}
      <OverlayActions>
        <Action tone="quiet" onClick={close}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" disabled={status.backup && !backedUp}>
          Update
        </Action>
      </OverlayActions>
    </form>
  );
}

function Progressing({
  phase,
  close,
}: {
  phase: Exclude<UpdatePhase, { step: 'idle' }>;
  close: () => void;
}) {
  const retry = () => useGatewayUpdate.setState({ phase: { step: 'idle' } });
  if (phase.step === 'done') {
    return (
      <Said title={`Jian ${phase.version} is running`} close={close} action={['Reload', reloadApp]}>
        Reload to use the panel of the new release.
      </Said>
    );
  }
  if (phase.step === 'failed') {
    return (
      <Said title="The update failed" close={close} action={['Try again', retry]}>
        <ul role="alert" className="grid gap-1 text-bad">
          {phase.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </Said>
    );
  }
  return <Waiting phase={phase} close={close} />;
}

function Waiting({
  phase,
  close,
}: {
  phase: { step: string; version: string };
  close: () => void;
}) {
  // Seconds since it started, so a long pull shows it is still going.
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const words =
    phase.step === 'starting'
      ? 'Asking for the update…'
      : `Waiting for Jian ${phase.version} to come back… ${seconds} s`;
  return (
    <Said title={`Updating to Jian ${phase.version}`} close={close} closeLabel="Hide">
      <span className="grid gap-3">
        <span>{words}</span>
        <Progress label={words} />
        <span>It can take a few minutes while the images are pulled. You can hide this.</span>
      </span>
    </Said>
  );
}

function Said({
  title,
  children,
  close,
  closeLabel = 'Close',
  action,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  closeLabel?: string;
  action?: [string, () => void];
}) {
  return (
    <div className="grid w-full gap-5 p-7">
      <header className="grid gap-1.5 pr-10">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <div className="text-sm leading-relaxed text-muted">{children}</div>
      </header>
      <OverlayActions>
        <Action tone={action ? 'quiet' : 'primary'} onClick={close}>
          {closeLabel}
        </Action>
        {action && (
          <Action tone="primary" onClick={action[1]}>
            {action[0]}
          </Action>
        )}
      </OverlayActions>
    </div>
  );
}
