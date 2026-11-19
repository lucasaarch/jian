'use client';

import { Fragment, useState } from 'react';
import {
  type AccountsOf,
  accountsOf,
  accountsSummary,
  type Credential,
  credentialOf,
} from '../../components/providers/accounts';
import { providers } from '../../components/providers/catalog';
import { connectionOf, type ProviderEntry, staleLine } from '../../components/providers/connection';
import {
  Action,
  SettingsGroup,
  SettingsPageSkeleton,
  SettingsRow,
  SettingsRowsSkeleton,
  StatusPill,
} from '../../kit';
import { useProviderAccounts, useProviderModels, useProviders } from '../../lib/query/agent';
import { useActions } from '../../lib/workspace';
import { CodexDialog } from './codex-dialog';
import { type AnthropicAs, ProviderDialog } from './provider-dialog';
import { ProviderTitle } from './provider-title';
import { ServicesCards } from './service-cards';

/** Which vendor's accounts are open: one of the catalog, one of Anthropic's two, or Codex. */
type Configuring = { entry: ProviderEntry; as?: AnthropicAs } | { codex: true };

/**
 * Anthropic's two credentials, each its line: an API key, or a Claude Code token. The gateway
 * keeps one Anthropic account active at a time, so adding one while the other is in use says
 * it switches.
 */
const anthropicAs = (credential: Credential, other: boolean): AnthropicAs =>
  credential === 'key'
    ? {
        credential,
        name: 'Anthropic',
        description: 'Claude models through an Anthropic API key, billed per token.',
        ...(other
          ? {
              replaces:
                'A Claude Code token is in use. Adding a key makes it the one runs use: the gateway uses one Anthropic account at a time.',
            }
          : {}),
      }
    : {
        credential,
        name: 'Claude Code',
        description:
          'Claude models through your Claude plan, with a token from claude setup-token.',
        ...(other
          ? {
              replaces:
                'An Anthropic API key is in use. Adding a token makes it the one runs use: the gateway uses one Anthropic account at a time.',
            }
          : {}),
      };

/**
 * The providers page while the gateway's are read: a row for each the catalog lists — Anthropic
 * twice, its key and Claude Code, and Codex beside OpenAI's key — then the two services.
 */
export function ProvidersWaiting() {
  return (
    <SettingsPageSkeleton label="Loading providers…">
      <SettingsGroup title="Models" note="Every agent can use them">
        <SettingsRowsSkeleton count={providers.length + 2} />
      </SettingsGroup>
      <SettingsGroup title="Services" note="For every agent">
        <SettingsRowsSkeleton count={2} from={3} />
      </SettingsGroup>
    </SettingsPageSkeleton>
  );
}

/**
 * The gateway's credentials: the model providers every agent can use, each a line saying whether
 * it is connected, everything else about it a click on Configure away; then the services the
 * installation reaches through a key of its own. Disconnecting asks to confirm by name.
 */
export function ProvidersPage() {
  const actions = useActions();
  return (
    <>
      <ProviderConnections />
      <ServicesCards {...actions} />
    </>
  );
}

/**
 * Every provider to connect, each a line with whether it is connected and, once it has accounts,
 * which one runs use and how many there are; Configure opens its accounts. `tiles` lays them two
 * to a line, for the onboarding, where the whole choice has to fit on one screen; settings keeps
 * them as one list under its title.
 */
export function ProviderConnections({ tiles = false }: { tiles?: boolean }) {
  const actions = useActions();
  const connected = useProviders();
  const accounts = useProviderAccounts();
  const lists = useProviderModels();
  // Kept while a dialog fades out, so it does not empty as it closes.
  const [configuring, setConfiguring] = useState<Configuring>();
  const [open, setOpen] = useState<'provider' | 'codex'>();
  const openai = connectionOf(connected, 'openai');
  const entry = configuring && 'entry' in configuring ? configuring.entry : undefined;
  const as = configuring && 'entry' in configuring ? configuring.as : undefined;
  const listed = (of: AccountsOf) => accountsOf(accounts, of);
  const live = entry ? connectionOf(connected, entry.kind).configured : undefined;
  // One of Anthropic's two is in use only when the active account is that credential.
  const using = as && live && credentialOf(live) !== as.credential ? undefined : live;

  const configure = (next: Configuring) => {
    setConfiguring(next);
    setOpen('entry' in next ? 'provider' : 'codex');
  };

  const rows = providers.map((item) => {
    const { configured } = connectionOf(connected, item.kind);
    const stale = configured ? Boolean(staleLine(lists[configured.id])) : false;
    const state = configured ? (stale ? 'unreachable' : 'connected') : undefined;
    if (item.kind === 'anthropic') {
      const held = configured ? credentialOf(configured) : undefined;
      return (
        <Fragment key={item.kind}>
          {(['key', 'subscription'] as const).map((credential) => {
            const shown = anthropicAs(credential, Boolean(held && held !== credential));
            return (
              <ProviderRow
                key={credential}
                kind="anthropic"
                name={shown.name}
                state={held === credential ? state : undefined}
                summary={accountsSummary(listed({ kind: 'anthropic', credential }))}
                onConfigure={() => configure({ entry: item, as: shown })}
              />
            );
          })}
        </Fragment>
      );
    }
    return (
      <Fragment key={item.kind}>
        <ProviderRow
          kind={item.kind}
          name={item.name}
          state={state}
          summary={accountsSummary(listed({ kind: item.kind }))}
          onConfigure={() => configure({ entry: item })}
        />
        {item.kind === 'openai' && (
          <ProviderRow
            kind="openai"
            name="Codex"
            state={openai.codex ? 'connected' : undefined}
            summary={accountsSummary(listed({ kind: 'openai', codex: true }))}
            onConfigure={() => configure({ codex: true })}
          />
        )}
      </Fragment>
    );
  });

  return (
    <>
      {tiles ? (
        <div className="grid gap-2 sm:grid-cols-2 sm:*:last:odd:col-span-2 *:rounded-xl *:border *:border-glass-edge *:bg-glass-hover">
          {rows}
        </div>
      ) : (
        <SettingsGroup title="Models" note="Every agent can use them">
          {rows}
        </SettingsGroup>
      )}
      <ProviderDialog
        entry={entry}
        {...(as ? { as } : {})}
        accounts={
          entry ? listed({ kind: entry.kind, ...(as ? { credential: as.credential } : {}) }) : []
        }
        environment={using?.apiKeyEnv ? using : undefined}
        stale={using ? Boolean(staleLine(lists[using.id])) : false}
        open={open === 'provider'}
        onOpenChange={(next) => !next && setOpen(undefined)}
        actions={actions}
      />
      <CodexDialog
        open={open === 'codex'}
        onOpenChange={(next) => !next && setOpen(undefined)}
        accounts={listed({ kind: 'openai', codex: true })}
        apiKey={Boolean(openai.configured)}
        actions={actions}
      />
    </>
  );
}

/** One vendor: its name, whether it is connected, its accounts, and the way into them. */
function ProviderRow({
  kind,
  name,
  state,
  summary,
  onConfigure,
}: {
  kind: string;
  name: string;
  state: 'connected' | 'unreachable' | undefined;
  /** The account in use and how many there are, once there is one. */
  summary: string | undefined;
  onConfigure: () => void;
}) {
  return (
    <SettingsRow
      description={summary}
      title={
        <span className="flex items-center gap-2">
          <ProviderTitle kind={kind}>{name}</ProviderTitle>
          {state === 'connected' && <StatusPill tone="good">Connected</StatusPill>}
          {state === 'unreachable' && <StatusPill tone="bad">Unreachable</StatusPill>}
        </span>
      }
    >
      <Action tone="outline" size="small" aria-label={`Configure ${name}`} onClick={onConfigure}>
        Configure
      </Action>
    </SettingsRow>
  );
}
