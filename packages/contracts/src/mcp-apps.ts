/**
 * Where each app of the panel's catalog keeps its MCP server, by the app's id: the address it
 * connects to first, then any it used before. The panel draws the cards; the gateway reads this
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
  mercado_pago: ['https://mcp.mercadopago.com/mcp'],
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
  // The query has AWS answer a call with no token by asking for sign-in, which is what starts
  // it here; without it the first call is answered and sign-in never begins.
  aws: ['https://aws-mcp.us-east-1.api.aws/mcp?oauth=initialize'],
  railway: ['https://mcp.railway.com'],
  hostinger: ['https://mcp.hostinger.com'],
  expo: ['https://mcp.expo.dev/mcp'],
  resend: ['https://mcp.resend.com/mcp'],
  postman: ['https://mcp.postman.com/mcp'],
  buildkite: ['https://mcp.buildkite.com/mcp'],
  mixpanel: ['https://mcp.mixpanel.com/mcp'],
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
