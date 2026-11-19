/**
 * Where each app of the panel's catalog keeps its MCP server, by the app's id: the address it
 * connects to first, then any other it is known at, where it used to be or a region's own. The panel draws the cards; the gateway reads this
 * to tell an app's server from one added by hand, which is all it needs to name an account after
 * its owner and to count an app's use without ever reporting an address.
 */
export const MCP_APP_ADDRESSES = {
  linear: ['https://mcp.linear.app/mcp'],
  atlassian: ['https://mcp.atlassian.com/v2/mcp', 'https://mcp.atlassian.com/v1/mcp'],
  trello: ['https://mcp.trello.com/v1'],
  todoist: ['https://ai.todoist.net/mcp'],
  clickup: ['https://mcp.clickup.com/mcp'],
  monday: ['https://mcp.monday.com/mcp'],
  notion: ['https://mcp.notion.com/mcp'],
  airtable: ['https://mcp.airtable.com/mcp'],
  zapier: ['https://mcp.zapier.com/api/mcp/mcp'],
  // Composio Connect: one hosted server for the apps Composio connects, signed in by OAuth.
  composio: ['https://connect.composio.dev/mcp'],
  'reactive-resume': ['https://rxresu.me/mcp'],
  make: ['https://mcp.make.com'],
  calendly: ['https://mcp.calendly.com'],
  cal_com: ['https://mcp.cal.com/mcp'],
  dropbox: ['https://mcp.dropbox.com/mcp'],
  canva: ['https://mcp.canva.com/mcp'],
  webflow: ['https://mcp.webflow.com/mcp'],
  wix: ['https://mcp.wix.com/mcp'],
  miro: ['https://mcp.miro.com/'],
  sanity: ['https://mcp.sanity.io'],
  stripe: ['https://mcp.stripe.com'],
  paypal: ['https://mcp.paypal.com/mcp'],
  square: ['https://mcp.squareup.com/mcp'],
  intercom: ['https://mcp.intercom.com/mcp'],
  attio: ['https://mcp.attio.com/mcp'],
  sentry: ['https://mcp.sentry.dev/mcp'],
  posthog: ['https://mcp.posthog.com/mcp'],
  vercel: ['https://mcp.vercel.com'],
  netlify: ['https://mcp.netlify.com/mcp'],
  cloudflare: ['https://mcp.cloudflare.com/mcp'],
  supabase: ['https://mcp.supabase.com/mcp'],
  neon: ['https://mcp.neon.tech/mcp'],
  prisma: ['https://mcp.prisma.io/mcp'],
  huggingface: ['https://huggingface.co/mcp'],
  gitlab: ['https://gitlab.com/api/v4/mcp'],
  railway: ['https://mcp.railway.com'],
  hostinger: ['https://mcp.hostinger.com'],
  expo: ['https://mcp.expo.dev/mcp'],
  resend: ['https://mcp.resend.com/mcp'],
  postman: ['https://mcp.postman.com/mcp'],
  buildkite: ['https://mcp.buildkite.com/mcp'],
  mixpanel: ['https://mcp.mixpanel.com/mcp'],
  higgsfield: ['https://mcp.higgsfield.ai/mcp'],
  // With the trailing slash: without it the server answers with a redirect to it, which the
  // gateway's client refuses to follow. A server saved without one is still HeyGen, as `same` says.
  heygen: ['https://mcp.heygen.com/mcp/v1/'],
  // The second is the same server for an account kept in the EU, which signs in on its own
  // authorization server.
  elevenlabs: ['https://api.elevenlabs.io/v1/mcp', 'https://api.eu.residency.elevenlabs.io/v1/mcp'],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type McpAppId = keyof typeof MCP_APP_ADDRESSES;

/** The same address however it was typed: a trailing slash makes no other server. */
const same = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** The catalog app a server's address belongs to, now or before it moved; none for any other. */
export function mcpAppOf(url: string | undefined): McpAppId | undefined {
  if (!url) return undefined;
  return (Object.keys(MCP_APP_ADDRESSES) as McpAppId[]).find((id) =>
    MCP_APP_ADDRESSES[id].some((known) => same(url, known)),
  );
}

/**
 * AWS is the one app that is no address: each account is AWS's managed MCP server, reached
 * through AWS's proxy run as a command with that account's keys in its environment, so a server
 * is AWS's by its command. The proxy signs each call with SigV4 for the endpoint's region, and
 * the account's `AWS_REGION` is where the calls operate.
 * https://docs.aws.amazon.com/agent-toolkit/latest/userguide/getting-started-aws-mcp-server.html
 */
export const AWS_MCP_COMMAND = 'uvx';
export const AWS_MCP_PACKAGE = 'mcp-proxy-for-aws-cli@latest';
/** The awslabs AWS API MCP server accounts ran before 1.12.1; migration 0116 moves them on. */
const AWS_API_MCP_PACKAGE = 'awslabs.aws-api-mcp-server@latest';

/** The regions AWS runs its MCP server in. */
export const AWS_MCP_REGIONS = [
  'us-east-1',
  'us-west-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
] as const;

/**
 * The server for an account in `region`: its own region's when AWS runs one there, otherwise one
 * on the same continent, otherwise N. Virginia. Only the signature's scope follows it; the calls
 * still operate in the account's region.
 */
export function awsMcpEndpoint(region: string): string {
  const own = (AWS_MCP_REGIONS as readonly string[]).includes(region);
  const near = region.startsWith('eu-')
    ? 'eu-west-1'
    : region.startsWith('ap-')
      ? 'ap-southeast-1'
      : 'us-east-1';
  return `https://aws-mcp.${own ? region : near}.api.aws/mcp`;
}

export const awsMcpArgs = (region: string) => [AWS_MCP_PACKAGE, awsMcpEndpoint(region)];

export const isAwsServer = (server: { command?: string | undefined; args?: readonly string[] }) =>
  server.command === AWS_MCP_COMMAND &&
  (server.args?.[0] === AWS_MCP_PACKAGE || server.args?.[0] === AWS_API_MCP_PACKAGE);
