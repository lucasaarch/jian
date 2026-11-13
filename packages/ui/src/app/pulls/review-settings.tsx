'use client';

import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { GitHubLogo } from '../../components/ui';
import {
  Action,
  MultiSelectField,
  Overlay,
  OverlayActions,
  SelectField,
  StatusPill,
  TextArea,
  Toggle,
} from '../../kit';
import { AgentFace } from '../../kit/face';
import type { GitHubReviewSettings, GitHubReviewsStatus } from '../../lib/api';
import { useAgents } from '../../lib/query/agent';
import { queries } from '../../lib/query/profile';
import { CopyLine, listBox } from '../customize/channel-copy-line';
import { useSaveReviewSettings, useSetUpWebhook } from './use-pulls';

/**
 * How agents review pull requests: who reviews, what they are told, and whether a pull request
 * newly opened on GitHub is reviewed without anyone asking.
 */
export function ReviewSettings({
  open,
  onOpenChange,
  status,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: GitHubReviewsStatus | undefined;
}) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Review settings" size="form">
      {status ? (
        // Keyed on what was saved, so reopening it shows that and not an abandoned draft.
        <SettingsForm
          key={JSON.stringify(status.settings)}
          status={status}
          close={() => onOpenChange(false)}
        />
      ) : (
        <p className="p-7 text-sm text-muted">Loading the review settings…</p>
      )}
    </Overlay>
  );
}

function SettingsForm({ status, close }: { status: GitHubReviewsStatus; close: () => void }) {
  const agents = useAgents();
  const repositories = useQuery(queries.githubRepositories()).data ?? [];
  const save = useSaveReviewSettings();
  const [draft, setDraft] = useState<GitHubReviewSettings>(status.settings);
  const change = (patch: Partial<GitHubReviewSettings>) => setDraft({ ...draft, ...patch });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(draft, { onSuccess: close });
  };

  return (
    <form onSubmit={submit} className="grid gap-5 p-7">
      <header className="grid gap-1 pr-10">
        <h2 className="text-lg font-semibold tracking-tight text-ink">Review settings</h2>
        <p className="text-sm leading-relaxed text-muted">
          A review is a new chat of the reviewing agent, on Auto, that posts its review on GitHub.
        </p>
      </header>

      <SelectField
        label="Reviewing agent"
        hint="Reviews started automatically use this agent. Unset, Review uses the agent open."
        value={draft.profileId ?? ''}
        placeholder="The agent open"
        options={agents.map((agent) => ({
          value: agent.id,
          label: agent.name,
          icon: <AgentFace name={agent.name} avatar={agent.avatar} size={1} />,
        }))}
        onValueChange={(profileId) => change({ profileId })}
      />
      <TextArea
        label="Instructions"
        hint="What every review looks for and how it is posted, added to the agent's own instructions."
        value={draft.instructions}
        maxLength={8000}
        rows={7}
        onChange={(event) => change({ instructions: event.target.value })}
      />

      {/* Bordered like the webhook card below, so the rows' own inset lines up with it. */}
      <div className="grid divide-y divide-line rounded-xl border border-line">
        <Toggle
          label="Review new pull requests"
          detail="When one is opened, reopened or marked ready on GitHub."
          checked={draft.auto}
          onCheckedChange={(auto) => change({ auto })}
        />
        <Toggle
          label="Include drafts"
          detail="Review a draft as soon as it is opened, not only once it is ready."
          checked={draft.drafts}
          onCheckedChange={(drafts) => change({ drafts })}
        />
      </div>
      {draft.auto && !draft.profileId && (
        <p className="text-xs text-warn">
          Choose a reviewing agent for reviews to start on their own.
        </p>
      )}
      {draft.auto && <Webhook status={status} />}

      {repositories.length > 0 && (
        <MultiSelectField
          label="Repositories"
          hint="With none chosen, new pull requests are reviewed in every repository the App can see."
          placeholder="Every repository"
          values={draft.repositories}
          options={repositories.map((repository) => ({
            // Saved lowercased by the gateway, so a choice is matched however GitHub cases it.
            value: repository.fullName.toLowerCase(),
            label: repository.fullName,
            icon: <GitHubLogo size={13} />,
          }))}
          onValuesChange={(names) => change({ repositories: names })}
        />
      )}

      <OverlayActions>
        <Action tone="quiet" onClick={close}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={save.isPending}>
          Save
        </Action>
      </OverlayActions>
    </form>
  );
}

/**
 * GitHub tells the gateway a pull request was opened through the App's webhook. An App Jian
 * makes now has one from the start; an older one has none, and GitHub's API only changes a
 * webhook that exists. Once the owner turns it on, with any address, the button sets its address
 * and secret, and the owner subscribes it to pull requests on GitHub, which no API can do.
 */
function Webhook({ status }: { status: GitHubReviewsStatus }) {
  const setUp = useSetUpWebhook();
  const { webhook } = status;
  return (
    <div className="grid gap-2 rounded-xl border border-line p-3.5 text-[13px]">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-ink">GitHub webhook</span>
        {webhook.receivedAt ? (
          <StatusPill tone="good">Receiving</StatusPill>
        ) : webhook.configured ? (
          <StatusPill tone="warn">Nothing received yet</StatusPill>
        ) : (
          <StatusPill tone="bad">Not set up</StatusPill>
        )}
      </div>
      {!webhook.url ? (
        <p className="text-muted">
          GitHub can only reach a gateway with a public address. Set one for this gateway first.
        </p>
      ) : (
        <>
          <p className="text-muted">
            {webhook.configured
              ? 'In the App’s settings on GitHub, the webhook must be Active and subscribed to the Pull request event.'
              : 'GitHub’s API can only change a webhook the App has. If Set up webhook says it has none, check Active under Webhook in the App’s settings on GitHub, enter any URL, such as this one, and save. Then set it up here and subscribe it to the Pull request event.'}
          </p>
          {/* Turning an older App's webhook on takes an address typed on GitHub: this one is at hand. */}
          <div className={listBox}>
            <CopyLine label="Webhook URL" value={webhook.url} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Action
              tone="outline"
              size="small"
              busy={setUp.isPending}
              onClick={() => setUp.mutate()}
            >
              {webhook.configured ? 'Set up again' : 'Set up webhook'}
            </Action>
            {webhook.appSettingsUrl && (
              <a
                href={webhook.appSettingsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted transition-colors hover:bg-glass-hover hover:text-ink"
              >
                Open the App on GitHub
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}
