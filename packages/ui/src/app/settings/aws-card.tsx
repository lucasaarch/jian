'use client';

import { AWS_MCP_COMMAND, AWS_MCP_PACKAGE, isAwsServer } from '@jian/contracts';
import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { mcpHealth } from '../../components/integrations/mcp-health';
import { useMcpServers } from '../../components/integrations/mcp-list';
import { Action, Overlay, OverlayActions, SettingsCard, StatusPill, TextField } from '../../kit';
import type { McpServer } from '../../lib/api';
import { useActions } from '../../lib/workspace';
import { AccountRow, AppIcon, useAccountChecks } from './mcp-app-card';
import { awsMark } from './mcp-apps';

const AWS = { name: 'AWS', icon: awsMark };

/** What the app gives, on its card and for the Apps search. */
export const AWS_DESCRIPTION =
  'AWS services through their APIs, as your IAM permissions allow, one account at a time.';

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
    <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
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
      <OverlayActions>
        {cancel && (
          <Action tone="quiet" onClick={cancel}>
            Cancel
          </Action>
        )}
        <Action tone="primary" type="submit" busy={busy} disabled={used || !name.slice(4)}>
          Connect account
        </Action>
      </OverlayActions>
    </form>
  );
}

/**
 * AWS's card among the apps. Each account is its own command server, so it keeps its own keys and
 * region and agents reach it by its name; they live in the MCP server list like the rest and this
 * card is all there is of them.
 */
export function AwsCard() {
  const { mutate, api } = useActions();
  const { servers, save, remove } = useMcpServers({ api, mutate });
  const accounts = servers.filter(isAwsServer);
  const checks = useAccountChecks(accounts.map((server) => server.name));
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  const healths = accounts.map((server) =>
    mcpHealth(checks.of(server.name), server.disabledTools ?? []),
  );
  const failing = healths.some((health) => health?.tone === 'bad');

  return (
    <>
      <SettingsCard
        icon={<AppIcon app={AWS} />}
        title={AWS.name}
        status={
          accounts.length > 0 && (
            <span role="status" className="flex flex-wrap gap-1.5">
              <StatusPill tone="good">
                {accounts.length > 1 ? `${accounts.length} accounts` : 'Connected'}
              </StatusPill>
              {failing && <StatusPill tone="bad">Unreachable</StatusPill>}
            </span>
          )
        }
        description={AWS_DESCRIPTION}
        action={
          <Action
            tone="outline"
            size="small"
            aria-label={accounts.length > 0 ? 'Configure AWS' : 'Connect AWS'}
            onClick={() => setOpen(true)}
          >
            {accounts.length > 0 ? 'Configure' : 'Connect'}
          </Action>
        }
      />
      <Overlay open={open} onOpenChange={setOpen} title="AWS" size="form">
        <div className="grid w-full grid-cols-1 gap-5 p-7">
          <header className="grid gap-1.5 pr-10">
            <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
              <AppIcon app={AWS} size={16} />
              AWS
            </h2>
            <p className="text-sm leading-relaxed text-muted">
              {AWS_DESCRIPTION} Every agent reaches each account below, by its name. Use keys of an
              IAM user limited to what agents may do; the server runs on this gateway and needs{' '}
              <code>uv</code> installed there.
            </p>
          </header>
          {accounts.length > 0 && (
            <ul className="divide-y divide-glass-edge rounded-xl border border-glass-edge bg-glass-hover">
              {accounts.map((server) => (
                <AccountRow
                  key={server.name}
                  app={AWS}
                  server={server}
                  check={checks.of(server.name)}
                  remove={() => remove(servers.indexOf(server))}
                />
              ))}
            </ul>
          )}
          {adding || accounts.length === 0 ? (
            <AwsForm
              taken={servers.map((server) => server.name)}
              save={async (server) => {
                const ok = await save(server, 'new');
                if (ok) setAdding(false);
                return ok;
              }}
              {...(accounts.length > 0 ? { cancel: () => setAdding(false) } : {})}
            />
          ) : (
            <OverlayActions>
              <Action tone="outline" onClick={() => setAdding(true)}>
                <Plus size={14} />
                Connect another account
              </Action>
              <span className="flex-1" />
              <Action tone="quiet" onClick={() => setOpen(false)}>
                Close
              </Action>
            </OverlayActions>
          )}
        </div>
      </Overlay>
    </>
  );
}
