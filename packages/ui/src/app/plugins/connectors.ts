import { isAwsServer } from '@jian/contracts';
import type { GithubIntegration } from '../../components/integrations/github-actions';
import type { XIntegration } from '../../components/integrations/x-actions';
import type { McpServer } from '../../lib/api';
import { matchesQuery } from '../../lib/search';
import {
  CATEGORIES,
  type Category,
  isAppServer,
  MCP_APPS,
  type McpApp,
  serversOf,
} from '../settings/mcp-apps';

/** What each of Jian's own gives, on its row in Plugins and its page, and for the search. */
const GITHUB_DESCRIPTION = 'Repositories, issues and pull requests for every agent.';
const X_DESCRIPTION = 'Post, read and search on X with your own developer app.';
const AWS_DESCRIPTION =
  'AWS services through their APIs, as your IAM permissions allow, one account at a time.';

/**
 * Whether this gateway offers GitHub at all: GitHub registers the App only for a gateway it can
 * send the owner back to, and what a gateway cannot do, or did not say it can, is not offered.
 */
const githubOffered = (integration: GithubIntegration | undefined) =>
  Boolean((integration?.configured && integration.app) || integration?.callbackUrl);

/**
 * Whether this gateway offers X: it needs an address X accepts to send the owner back to, so a
 * gateway without one, whatever the reason, offers nothing it could not finish.
 */
const xOffered = (integration: XIntegration | undefined) => Boolean(integration?.callbackUrl);

/** What a connector is underneath, which decides its mark and what opens for it. */
type ConnectorSource =
  | { kind: 'github' }
  | { kind: 'x' }
  | { kind: 'aws' }
  | { kind: 'app'; app: McpApp }
  | { kind: 'custom'; server: McpServer };

/**
 * One way the agents reach an account or a service of the owner's, shared by every agent. Jian
 * provides most: GitHub, X, AWS and the catalog of services' own MCP servers. One the owner adds
 * by hand, an MCP server of any kind, is custom.
 */
export type Connector = {
  id: string;
  name: string;
  description: string;
  /** Who makes the service, for one Jian provides: a custom connector has none. */
  by?: string;
  category?: Category;
  /** With an account in, or saved by the owner: listed ahead of the rest. */
  connected: boolean;
  source: ConnectorSource;
};

/** Whether Jian provides the connector, which earns it the verified badge. */
export const isVerified = (connector: Connector) => connector.source.kind !== 'custom';

/** What kind of thing a row is and where it comes from, under its description. */
export const connectorMeta = (connector: Connector) =>
  connector.by ? `Connector · By ${connector.by}` : 'Connector · Custom';

/**
 * Every connector this gateway can offer, the connected ones first, each group in the catalog's
 * order. GitHub and X are there only on a gateway that can finish connecting them. A saved server
 * that is one of Jian's (an app's address, an AWS account) counts under that connector and is
 * never listed again as a custom one.
 */
export function connectorsOf({
  github,
  x,
  servers,
}: {
  github: GithubIntegration | undefined;
  x: XIntegration | undefined;
  servers: McpServer[];
}): Connector[] {
  const provided: Connector[] = [
    ...(githubOffered(github)
      ? [
          {
            id: 'github',
            name: 'GitHub',
            by: 'GitHub',
            description: GITHUB_DESCRIPTION,
            category: 'development' as const,
            connected: (github?.accounts.length ?? 0) > 0,
            source: { kind: 'github' as const },
          },
        ]
      : []),
    ...(xOffered(x)
      ? [
          {
            id: 'x',
            name: 'X',
            by: 'X',
            description: X_DESCRIPTION,
            category: 'social' as const,
            connected: (x?.accounts.length ?? 0) > 0,
            source: { kind: 'x' as const },
          },
        ]
      : []),
    {
      id: 'aws',
      name: 'AWS',
      by: 'AWS',
      description: AWS_DESCRIPTION,
      category: 'development',
      connected: servers.some(isAwsServer),
      source: { kind: 'aws' },
    },
    ...MCP_APPS.map((app) => ({
      id: app.id,
      name: app.name,
      by: app.by,
      description: app.description,
      category: app.category,
      connected: serversOf(app, servers).length > 0,
      source: { kind: 'app' as const, app },
    })),
  ];
  const custom: Connector[] = servers
    .filter((server) => !isAppServer(server))
    .map((server) => ({
      // Never one of Jian's ids, whatever the owner named the server.
      id: `custom:${server.name}`,
      name: server.name,
      description: server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' '),
      connected: true,
      source: { kind: 'custom', server },
    }));

  return [...provided, ...custom].sort((a, b) => Number(b.connected) - Number(a.connected));
}

/** The connectors a search leaves: found by name, category, maker and what they give. */
export function narrowConnectors(connectors: Connector[], query: string) {
  return connectors.filter((connector) => {
    const text = `${connector.name} ${connector.category ? CATEGORIES[connector.category] : ''} ${connector.description} ${connector.by ?? 'custom'}`;
    return matchesQuery(text, query);
  });
}
