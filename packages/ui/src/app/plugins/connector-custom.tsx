'use client';

import { Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { mcpHealth } from '../../components/integrations/mcp-health';
import { useMcpServers } from '../../components/integrations/mcp-list';
import {
  Action,
  ConfirmDialog,
  MenuEntry,
  SettingsGroup,
  SettingsRow,
  StatusPill,
} from '../../kit';
import type { McpServer } from '../../lib/api';
import { useActions } from '../../lib/workspace';
import { ToolList, toolsOf, useAccountChecks } from './connector-accounts';
import { ConnectorFrame, reading } from './connector-frame';
import type { Connector } from './connectors';
import { McpFields, useMcpDraft } from './mcp-fields';
import { MoreMenu, PluginEditActions } from './plugin-page';

const AUTH = { none: 'None', headers: 'Headers', oauth: 'OAuth' } as const;

/** Where the page goes once the server it showed is no longer at this address. */
export type Leave = (change: () => Promise<boolean>, renamedTo?: string) => Promise<boolean>;

/**
 * A custom connector, an MCP server the owner added, on its page: whether it answers, asked of
 * it as the page opens, and the tools it offers, each with the switch that offers it to every
 * agent or to none. Edit puts its fields in the page, in place of what it reads, with a test of
 * the connection before saving; removing it asks for its name first, since its credentials go
 * with it. The whole list is what the gateway saves: Jian's own servers are in it too, and keep
 * their places. `leave` runs a change that takes the server from this address, its removal or a
 * new name, and goes where it now is.
 */
export function CustomConnector({
  connector,
  server,
  back,
  leave,
}: {
  connector: Connector;
  server: McpServer;
  back: () => void;
  leave: Leave;
}) {
  const { api, mutate, busy } = useActions();
  const { servers, save, remove, toggleTool } = useMcpServers({ api, mutate });
  const checks = useAccountChecks([server.name]);
  const check = checks.of(server.name);
  const off = server.disabledTools ?? [];
  const health = mcpHealth(check, off);
  const tools = toolsOf([server], checks);
  const signIn = check.status?.authorizationUrl;
  const form = useId();
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  // By name: the list is saved whole, and the server's place in it is where it is found now.
  const place = () => servers.findIndex((item) => item.name === server.name);
  const address = server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');

  return (
    <>
      <ConnectorFrame
        connector={connector}
        back={back}
        lead="An MCP server you added. Every agent reaches it, and loads the tools it needs from it."
        actions={
          editing ? (
            <PluginEditActions form={form} busy={busy} onCancel={() => setEditing(false)} />
          ) : (
            <>
              <Action tone="outline" size="field" onClick={() => setEditing(true)}>
                Edit
              </Action>
              <MoreMenu>
                <MenuEntry icon={<Trash2 size={14} />} danger onClick={() => setAsking(true)}>
                  Remove
                </MenuEntry>
              </MoreMenu>
            </>
          )
        }
        // How it stands, where it is and its tools are said once, in the page beside this.
        details={[
          ['Type', 'MCP server'],
          ['Auth', AUTH[server.auth ?? 'none']],
        ]}
      >
        {editing ? (
          <EditForm
            id={form}
            server={server}
            onSave={async (next) => {
              const at = place();
              if (at < 0) return false;
              const ok =
                next.name === server.name
                  ? await save(next, at)
                  : await leave(() => save(next, at), next.name);
              if (ok) {
                setEditing(false);
                void checks.check(next.name);
              }
              return ok;
            }}
          />
        ) : (
          <>
            <SettingsGroup title="Connection">
              <SettingsRow
                title={<span className="font-mono [overflow-wrap:anywhere]">{address}</span>}
                description={
                  check.error ||
                  check.status?.error ||
                  // The tools' own list counts them when it shows.
                  (tools?.length ? undefined : health?.tools)
                }
              >
                {health && (
                  <span role="status">
                    <StatusPill tone={health.tone === 'neutral' ? 'quiet' : health.tone}>
                      {health.label}
                    </StatusPill>
                  </span>
                )}
                {signIn && (
                  <Action
                    tone="outline"
                    size="small"
                    onClick={() => window.open(signIn, '_blank', 'noopener,noreferrer')}
                  >
                    Sign in
                  </Action>
                )}
                <Action
                  tone="outline"
                  size="small"
                  busy={check.busy}
                  onClick={() => void checks.check(server.name)}
                >
                  Check again
                </Action>
              </SettingsRow>
            </SettingsGroup>
            {tools && tools.length > 0 && (
              <ToolList
                tools={tools}
                off={off}
                onToggle={(tool) => void toggleTool(server, tool)}
              />
            )}
          </>
        )}
      </ConnectorFrame>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${server.name}?`}
        phrase={server.name}
        action="Remove server"
        busy={busy}
        run={() => {
          const at = place();
          if (at >= 0) void leave(() => remove(at));
        }}
      >
        Every agent stops reaching it on its next runs, and its credentials are deleted. This cannot
        be undone.
      </ConfirmDialog>
    </>
  );
}

/**
 * The server's fields, in the page while it is edited. Save and Cancel are the header's, which
 * send this form by its `id`; the test of what the fields hold, before any of it is saved, is
 * the form's own.
 */
function EditForm({
  id,
  server,
  onSave,
}: {
  id: string;
  server: McpServer;
  onSave: (next: McpServer) => Promise<boolean>;
}) {
  const { api, busy } = useActions();
  const fields = useMcpDraft(api, server);
  const form = useRef<HTMLFormElement>(null);
  const [failed, setFailed] = useState(false);

  return (
    <form
      id={id}
      ref={form}
      aria-label={`Edit ${server.name}`}
      className={`grid gap-5 ${reading}`}
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(fields.made()).then((ok) => setFailed(!ok));
      }}
    >
      <McpFields {...fields} server={server} busy={busy} />
      {failed && (
        <p role="alert" className="text-sm text-bad">
          Could not save. Check the fields, or refresh the page.
        </p>
      )}
      <div>
        <Action
          tone="outline"
          size="field"
          busy={fields.testing}
          disabled={busy}
          onClick={() => {
            if (form.current?.reportValidity()) void fields.test();
          }}
        >
          Test connection
        </Action>
      </div>
    </form>
  );
}
