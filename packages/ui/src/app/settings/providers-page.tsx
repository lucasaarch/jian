'use client';

import { Fragment, useState } from 'react';
import { providers } from '../../components/providers/catalog';
import { connectionOf, type ProviderEntry, staleLine } from '../../components/providers/connection';
import { Action, ConfirmDialog, SettingsGroup, SettingsRow, StatusPill } from '../../kit';
import type { Provider } from '../../lib/api';
import { useProviderModels, useProviders } from '../../lib/query/agent';
import { useActions } from '../../lib/workspace';
import { CodexDialog } from './codex-dialog';
import { type AnthropicAs, type Credential, ProviderDialog } from './provider-dialog';
import { ProviderTitle } from './provider-title';
import { ServicesCards } from './service-cards';

/** A credential about to be removed, and how its confirmation names it. */
type Removal = { provider: Provider; name: string; action: string; done: string };

/** Which of Anthropic's credentials a stored provider is; one from the environment says so too. */
const credentialOf = (provider: Provider): Credential =>
  provider.credential === 'subscription' || provider.apiKeyEnv === 'ANTHROPIC_API_TOKEN'
    ? 'subscription'
    : 'key';

/** Which vendor's settings are open: one of the catalog, one of Anthropic's two, or Codex. */
type Configuring = { entry: ProviderEntry; as?: AnthropicAs } | { codex: true };

/**
 * Anthropic's two credentials, each its line: an API key, or a Claude Code token. The gateway
 * keeps one Anthropic credential at a time, so saving one says it replaces the other.
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
                'Connecting replaces the Claude Code token: the gateway keeps one Anthropic credential at a time.',
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
                'Connecting replaces the Anthropic API key: the gateway keeps one Anthropic credential at a time.',
            }
          : {}),
      };

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

/** Shared connection controls keep first-run and Settings on the same authentication flows. */
export function ProviderConnections() {
  const actions = useActions();
  const { api, mutate, busy } = actions;
  const connected = useProviders();
  const lists = useProviderModels();
  // Kept while a dialog fades out, so it does not empty as it closes.
  const [configuring, setConfiguring] = useState<Configuring>();
  const [open, setOpen] = useState<'provider' | 'codex'>();
  const [removal, setRemoval] = useState<Removal>();
  const openai = connectionOf(connected, 'openai');
  const entry = configuring && 'entry' in configuring ? configuring.entry : undefined;
  const as = configuring && 'entry' in configuring ? configuring.as : undefined;
  const live = entry ? connectionOf(connected, entry.kind).configured : undefined;
  // One of Anthropic's two is configured only when what is stored is that credential.
  const editing = as && live && credentialOf(live) !== as.credential ? undefined : live;

  const configure = (next: Configuring) => {
    setConfiguring(next);
    setOpen('entry' in next ? 'provider' : 'codex');
  };

  return (
    <>
      <SettingsGroup title="Models" note="Every agent can use them">
        {providers.map((item) => {
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
                onConfigure={() => configure({ entry: item })}
              />
              {item.kind === 'openai' && (
                <ProviderRow
                  kind="openai"
                  name="Codex"
                  state={openai.codex ? 'connected' : undefined}
                  onConfigure={() => configure({ codex: true })}
                />
              )}
            </Fragment>
          );
        })}
      </SettingsGroup>
      <ProviderDialog
        entry={entry}
        {...(as ? { as } : {})}
        configured={editing}
        list={editing ? lists[editing.id] : undefined}
        open={open === 'provider'}
        onOpenChange={(next) => !next && setOpen(undefined)}
        onDisconnect={(provider) =>
          entry &&
          setRemoval({
            provider,
            name: as?.name ?? entry.name,
            action: `Disconnect ${as?.name ?? entry.name}`,
            done: `${as?.name ?? entry.name} disconnected.`,
          })
        }
        actions={actions}
      />
      <CodexDialog
        open={open === 'codex'}
        onOpenChange={(next) => !next && setOpen(undefined)}
        codex={openai.codex}
        apiKey={Boolean(openai.configured)}
        actions={actions}
        onDisconnect={(provider) =>
          setRemoval({
            provider,
            name: 'Codex',
            action: 'Disconnect Codex',
            done: 'Codex disconnected.',
          })
        }
      />
      <ConfirmDialog
        open={Boolean(removal)}
        onOpenChange={(next) => !next && setRemoval(undefined)}
        title={`Disconnect ${removal?.name ?? ''}?`}
        phrase={removal?.name ?? ''}
        action={removal?.action ?? 'Disconnect'}
        busy={busy}
        run={async () => {
          if (!removal) return;
          if (await mutate(() => api.revokeProvider(removal.provider.id), removal.done)) {
            setRemoval(undefined);
            setOpen(undefined);
          }
        }}
      >
        Its credential is deleted from the gateway and agents can no longer use its models. Connect
        it again whenever you like.
      </ConfirmDialog>
    </>
  );
}

/** One vendor: its name, whether it is connected, and the way into its settings. */
function ProviderRow({
  kind,
  name,
  state,
  onConfigure,
}: {
  kind: string;
  name: string;
  state: 'connected' | 'unreachable' | undefined;
  onConfigure: () => void;
}) {
  return (
    <SettingsRow
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
