'use client';

import { useMcpServers } from '../../components/integrations/mcp-list';
import { Action } from '../../kit';
import { useGatewayMode } from '../../lib/gateway-mode';
import { useActions } from '../../lib/workspace';
import { freeName, type McpApp, serversOf } from '../settings/mcp-apps';
import {
  AccountList,
  accountsStatus,
  ToolList,
  toolsOf,
  useAccountChecks,
} from './connector-accounts';
import { ConnectorFrame, Note } from './connector-frame';
import type { Connector } from './connectors';

/**
 * One app of the catalog, on its page: the service's own MCP server, signed in with OAuth.
 * Connect saves it and opens its sign-in; each account after that is another server at the same
 * address, listed here with how it stands, and the page is all there is of them: Plugins never
 * lists them as custom connectors.
 */
export function AppConnector({
  connector,
  app,
  back,
}: {
  connector: Connector;
  app: McpApp;
  back: () => void;
}) {
  const { api, mutate, busy } = useActions();
  const { servers, save, remove } = useMcpServers({ api, mutate });
  const accounts = serversOf(app, servers);
  const checks = useAccountChecks(accounts.map((server) => server.name));
  const tools = toolsOf(accounts, checks);
  const mode = useGatewayMode();
  // Until the gateway says what it is, an app only a server can sign in to offers nothing: a
  // Connect that appeared and went would be one the owner could press on the wrong gateway.
  const offered = !app.needsHttps || mode === 'server';
  const connect = () =>
    save(
      {
        name: freeName(
          app,
          servers.map((item) => item.name),
        ),
        transport: 'http',
        url: app.url,
        auth: 'oauth',
        headers: [],
        args: [],
        env: [],
        disabledTools: [],
      },
      'new',
    );

  return (
    <ConnectorFrame
      connector={connector}
      back={back}
      lead={`${app.description} Every agent reaches each account you connect, by its name.`}
      actions={
        offered && (
          <Action
            tone={accounts.length > 0 ? 'outline' : 'primary'}
            size="field"
            busy={busy}
            {...(accounts.length > 0 ? {} : { 'aria-label': `Connect ${app.name}` })}
            onClick={() => void connect()}
          >
            {accounts.length > 0 ? 'Add account' : 'Connect'}
          </Action>
        )
      }
      details={[
        ['Status', accountsStatus(accounts, checks)],
        ['Type', 'MCP server'],
        ['Address', app.url],
        ['Auth', 'OAuth'],
      ]}
    >
      {accounts.length > 0 && (
        <AccountList
          service={app.name}
          accounts={accounts}
          checks={checks}
          remove={(server) => remove(servers.indexOf(server))}
        />
      )}
      {app.needsHttps && (
        <Note>
          {mode === 'local'
            ? `${app.name} signs in by reading who Jian is from the gateway’s HTTPS address, which the desktop app’s own gateway does not have. Connect it on a server gateway whose JIAN_PUBLIC_URL is its https:// address.`
            : `${app.name} signs in by reading who Jian is from this gateway, so it needs JIAN_PUBLIC_URL set to the gateway’s https:// address, one the internet reaches.`}
        </Note>
      )}
      {app.note && <Note>{app.note}</Note>}
      <Note>
        Each account is named after who signs in, once {app.name} says who that is. It signs in
        whichever account your browser is logged into: to connect another one, switch account there
        first, or open the sign-in in a private window.
      </Note>
      {tools && tools.length > 0 && <ToolList tools={tools} />}
    </ConnectorFrame>
  );
}
