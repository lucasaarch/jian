import { readdir, readFile } from 'node:fs/promises';
import { AWS_MCP_COMMAND, AWS_MCP_PACKAGE, awsMcpEndpoint, isAwsServer } from '@jian/contracts';
import { asc, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { mcpServers } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const stdio = (name: string, args: string[], disabledTools: string[] = []) => ({
  name,
  transport: 'stdio',
  command: 'uvx',
  args,
  auth: 'none',
  headers: [],
  env: [{ name: 'AWS_REGION', secret: true }],
  disabledTools,
});

async function migrate(db: Awaited<ReturnType<typeof testServices>>['store']['db']) {
  // Found by name, not number: a migration merged first may move this one along.
  const folder = new URL('../migrations/', import.meta.url);
  const file = (await readdir(folder)).find((name) => name.endsWith('_aws-mcp-server.sql'));
  await db.execute(sql.raw(await readFile(new URL(file ?? 'missing.sql', folder), 'utf8')));
}

it('moves an account of the AWS API MCP server to AWS MCP Server, and nothing else', async () => {
  const services = await testServices();
  const db = services.store.db;
  const old = stdio('aws_work', ['awslabs.aws-api-mcp-server@latest'], ['call_aws']);
  const other = stdio('fetcher', ['mcp-server-fetch']);
  const remote = { ...stdio('linear', []), transport: 'http', url: 'https://mcp.linear.app/mcp' };
  for (const [position, server] of [old, other, remote].entries()) {
    await db.execute(sql`INSERT INTO mcp_servers (name, server, position)
      VALUES (${server.name}, ${JSON.stringify(server)}::jsonb, ${position})`);
  }

  await migrate(db);
  // Again: an account already moved is left as it is.
  await migrate(db);

  const [aws, fetcher, linear] = await db
    .select()
    .from(mcpServers)
    .orderBy(asc(mcpServers.position));
  expect(aws?.server).toEqual({
    ...old,
    command: AWS_MCP_COMMAND,
    args: [AWS_MCP_PACKAGE, 'https://aws-mcp.us-east-1.api.aws/mcp'],
    disabledTools: [],
  });
  // The keys and the region stay where they were: only the arguments changed.
  expect(aws?.server.env).toEqual(old.env);
  expect(aws && isAwsServer(aws.server)).toBe(true);
  expect(fetcher?.server).toEqual(other);
  expect(linear?.server).toEqual(remote);
});

it('signs for the account region where AWS runs the server, else the nearest one', () => {
  expect(awsMcpEndpoint('eu-west-2')).toBe('https://aws-mcp.eu-west-2.api.aws/mcp');
  expect(awsMcpEndpoint('eu-south-1')).toBe('https://aws-mcp.eu-west-1.api.aws/mcp');
  expect(awsMcpEndpoint('ap-south-1')).toBe('https://aws-mcp.ap-southeast-1.api.aws/mcp');
  expect(awsMcpEndpoint('sa-east-1')).toBe('https://aws-mcp.us-east-1.api.aws/mcp');
  expect(awsMcpEndpoint('')).toBe('https://aws-mcp.us-east-1.api.aws/mcp');
});
