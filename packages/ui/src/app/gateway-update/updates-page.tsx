'use client';

import type { UpdateComponent, UpdateStatus } from '@jian/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Action,
  ConfirmDialog,
  SettingsGroup,
  SettingsPageSkeleton,
  SettingsRow,
  SettingsRowsSkeleton,
  StatusPill,
} from '../../kit';
import { calendarDate, date } from '../../lib/format';
import { panelApi } from '../../lib/query/client';
import { keys } from '../../lib/query/keys';
import { notifyError } from '../../lib/workspace';
import { updateStatus } from './query';
import { askToUpdate } from './store';
import { failures } from './wait';
import { WebhookDialog } from './webhook-dialog';
import { type WebhookDraft, webhookInput, webhookSummary } from './webhook-draft';

const COMPONENTS: { id: UpdateComponent; title: string }[] = [
  { id: 'gateway', title: 'Gateway' },
  { id: 'web', title: 'Web panel' },
];

export function UpdatesWaiting() {
  return (
    <SettingsPageSkeleton label="Loading updates…">
      <SettingsGroup title="Version">
        <SettingsRowsSkeleton count={2} description />
      </SettingsGroup>
    </SettingsPageSkeleton>
  );
}

/**
 * How this server installation updates itself: the release it runs and the one waiting, with
 * the button that installs it, and the way it is done, the compose updater or the platform's
 * redeploy webhooks, one per component.
 */
export function UpdatesPage() {
  const client = useQueryClient();
  const { data: status, error, isPending } = useQuery(updateStatus());
  const [editing, setEditing] = useState<UpdateComponent>();
  const [removing, setRemoving] = useState<UpdateComponent>();
  const show = (next: UpdateStatus) => client.setQueryData(keys.updates, next);
  const { mutateAsync, isPending: busy } = useMutation({
    mutationFn: (run: () => Promise<UpdateStatus>) => run(),
    onSuccess: show,
  });
  const change = (run: () => Promise<UpdateStatus>, said: string) =>
    mutateAsync(run).then(
      () => {
        toast.success(said);
        return true;
      },
      (failure: unknown) => {
        notifyError(failure, 'The webhook could not be saved.');
        return false;
      },
    );

  if (isPending) return <UpdatesWaiting />;
  if (!status) {
    return (
      <SettingsGroup title="Version">
        <SettingsRow
          title="Updates"
          description={
            <span role="alert" className="text-bad">
              {error instanceof Error ? error.message : 'Could not read how this gateway updates.'}
            </span>
          }
        />
      </SettingsGroup>
    );
  }

  return (
    <>
      <Version status={status} />
      <SettingsGroup title="Compose updater">
        <SettingsRow
          title={
            <span className="flex items-center gap-2">
              jian-updater
              <StatusPill tone={status.method === 'sidecar' ? 'good' : 'quiet'}>
                {status.method === 'sidecar' ? 'On' : 'Off'}
              </StatusPill>
            </span>
          }
          description={
            status.method === 'sidecar'
              ? 'It installs updates here; the webhooks below are not used.'
              : 'With docker compose: set COMPOSE_PROFILES=updater and JIAN_UPDATER_URL=http://updater:8080 in .env, then docker compose up -d. It holds the Docker socket, which is root on the host.'
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Redeploy webhooks">
        {COMPONENTS.map(({ id, title }) => {
          const webhook = status.webhooks[id];
          return (
            <SettingsRow
              key={id}
              title={title}
              description={webhook ? webhookSummary(webhook) : 'Not set up'}
            >
              <Action tone="outline" size="small" disabled={busy} onClick={() => setEditing(id)}>
                {webhook ? 'Replace' : 'Set up'}
              </Action>
              {webhook && (
                <Action
                  tone="danger"
                  size="small"
                  className="border border-bad/40"
                  disabled={busy}
                  onClick={() => setRemoving(id)}
                >
                  Remove
                </Action>
              )}
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      <WebhookDialog
        component={editing}
        onOpenChange={(open) => !open && setEditing(undefined)}
        busy={busy}
        save={(component, draft: WebhookDraft) =>
          change(
            () => panelApi().saveUpdateWebhook(component, webhookInput(draft)),
            'Webhook saved.',
          )
        }
      />
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title="Remove this webhook?"
        action="Remove webhook"
        busy={busy}
        run={() => {
          const component = removing;
          if (!component) return;
          void change(() => panelApi().removeUpdateWebhook(component), 'Webhook removed.').then(
            (done) => done && setRemoving(undefined),
          );
        }}
      >
        Jian no longer calls it to update. Without the gateway’s, updates from here stop.
      </ConfirmDialog>
    </>
  );
}

function Version({ status }: { status: UpdateStatus }) {
  const last = status.attempts[0];
  return (
    <SettingsGroup title="Version">
      <SettingsRow
        title="This gateway"
        description={status.current ? `Jian ${status.current}` : 'A build with no release version'}
      />
      {status.latest ? (
        <SettingsRow
          title={`Jian ${status.latest.version} is available`}
          description={
            status.method === 'none'
              ? 'Set up the compose updater or the gateway’s webhook below to install it from here.'
              : `Released ${calendarDate(status.latest.date)}.${status.backup ? ' Back up the database first.' : ''}`
          }
        >
          <Action
            tone="primary"
            size="small"
            disabled={status.method === 'none'}
            onClick={askToUpdate}
          >
            Update
          </Action>
        </SettingsRow>
      ) : (
        <SettingsRow title="Up to date" description="No newer release on GitHub." />
      )}
      {last && (
        <SettingsRow
          title="Last update"
          description={
            last.ok
              ? `${date(last.at)}: ${last.version} started by ${last.method}.`
              : `${date(last.at)}: ${last.version} failed. ${failures(last).join(' ')}`
          }
        />
      )}
    </SettingsGroup>
  );
}
