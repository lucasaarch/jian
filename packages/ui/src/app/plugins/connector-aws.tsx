'use client';

import { AWS_MCP_COMMAND, AWS_MCP_PACKAGE, isAwsServer } from '@jian/contracts';
import { type FormEvent, useState } from 'react';
import { useMcpServers } from '../../components/integrations/mcp-list';
import { Action, TextField } from '../../kit';
import type { McpServer } from '../../lib/api';
import { useActions } from '../../lib/workspace';
import {
  AccountList,
  accountsStatus,
  ToolList,
  toolsOf,
  useAccountChecks,
} from './connector-accounts';
import { ConnectorFrame, reading } from './connector-frame';
import type { Connector } from './connectors';
import { PluginSection } from './plugin-list';

/** The server's name for an account: what agents call it by, so it follows the name rule. */
const serverName = (account: string) =>
  `aws_${account
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 26)}`;

/**
 * One account as the command server that runs it: the awslabs AWS API MCP server, started on
 * this gateway with the account's keys in its environment. The keys go to the gateway's vault on
 * save and never come back, so the form is always typed anew.
 */
function awsServer(name: string, keys: Record<string, string>): McpServer {
  return {
    name,
    transport: 'stdio',
    command: AWS_MCP_COMMAND,
    args: [AWS_MCP_PACKAGE],
    auth: 'none',
    headers: [],
    env: Object.entries(keys)
      .filter(([, value]) => value)
      .map(([key, value]) => ({ name: key, value })),
    disabledTools: [],
  };
}

function AwsForm({
  taken,
  save,
  cancel,
}: {
  taken: string[];
  save: (server: McpServer) => Promise<boolean>;
  cancel?: () => void;
}) {
  const { busy } = useActions();
  const [account, setAccount] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const name = serverName(account);
  const used = account.trim() !== '' && taken.includes(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (used) return;
    await save(
      awsServer(name, {
        AWS_ACCESS_KEY_ID: accessKeyId.trim(),
        AWS_SECRET_ACCESS_KEY: secretAccessKey.trim(),
        AWS_SESSION_TOKEN: sessionToken.trim(),
        AWS_REGION: region.trim(),
      }),
    );
  };

  return (
    <form
      aria-label="New AWS account"
      className={`grid gap-4 ${reading}`}
      onSubmit={(event) => void submit(event)}
    >
      <TextField
        label="Account name"
        value={account}
        autoComplete="off"
        required
        hint={
          used
            ? `${name} is already in use. Pick another name.`
            : `Agents reach it as ${account.trim() ? name : 'aws_…'}. Letters, numbers and underscores.`
        }
        onChange={(event) => setAccount(event.target.value)}
      />
      <TextField
        label="Access key ID"
        value={accessKeyId}
        autoComplete="off"
        required
        onChange={(event) => setAccessKeyId(event.target.value)}
      />
      <TextField
        label="Secret access key"
        type="password"
        value={secretAccessKey}
        autoComplete="off"
        required
        hint="Kept in this gateway's vault, and never shown again."
        onChange={(event) => setSecretAccessKey(event.target.value)}
      />
      <TextField
        label="Session token (optional)"
        type="password"
        value={sessionToken}
        autoComplete="off"
        hint="Only for temporary credentials."
        onChange={(event) => setSessionToken(event.target.value)}
      />
      <TextField
        label="Region"
        value={region}
        autoComplete="off"
        required
        onChange={(event) => setRegion(event.target.value)}
      />
      <div className="flex items-center justify-end gap-2">
        {cancel && (
          <Action tone="quiet" size="field" onClick={cancel}>
            Cancel
          </Action>
        )}
        <Action
          tone="primary"
          size="field"
          type="submit"
          busy={busy}
          disabled={used || !name.slice(4)}
        >
          Connect account
        </Action>
      </div>
    </form>
  );
}

/**
 * AWS, on its page. Each account is its own command server, so it keeps its own keys and region
 * and agents reach it by its name; they live in the MCP server list like the rest and this page
 * is all there is of them. The keys of a new account are typed in the page: with none yet the
 * form is there from the start, and Add account brings it back.
 */
export function AwsConnector({ connector, back }: { connector: Connector; back: () => void }) {
  const { api, mutate } = useActions();
  const { servers, save, remove } = useMcpServers({ api, mutate });
  const accounts = servers.filter(isAwsServer);
  const checks = useAccountChecks(accounts.map((server) => server.name));
  const tools = toolsOf(accounts, checks);
  const [adding, setAdding] = useState(false);

  return (
    <ConnectorFrame
      connector={connector}
      back={back}
      lead={
        <>
          {connector.description} Every agent reaches each account you connect, by its name. Use
          keys of an IAM user limited to what agents may do; the server runs on this gateway and
          needs <code>uv</code> installed there.
        </>
      }
      actions={
        accounts.length > 0 &&
        !adding && (
          <Action tone="outline" size="field" onClick={() => setAdding(true)}>
            Add account
          </Action>
        )
      }
      details={[
        ['Status', accountsStatus(accounts, checks)],
        ['Type', 'MCP server'],
        ['Auth', 'Access keys'],
      ]}
    >
      {accounts.length > 0 && (
        <AccountList
          service="AWS"
          accounts={accounts}
          checks={checks}
          remove={(server) => remove(servers.indexOf(server))}
        />
      )}
      {(adding || accounts.length === 0) && (
        <PluginSection title="New account">
          <AwsForm
            taken={servers.map((server) => server.name)}
            save={async (server) => {
              const ok = await save(server, 'new');
              if (ok) setAdding(false);
              return ok;
            }}
            {...(accounts.length > 0 ? { cancel: () => setAdding(false) } : {})}
          />
        </PluginSection>
      )}
      {tools && tools.length > 0 && <ToolList tools={tools} />}
    </ConnectorFrame>
  );
}
