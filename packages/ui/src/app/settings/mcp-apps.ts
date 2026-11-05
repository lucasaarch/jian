import {
  type SimpleIcon,
  siAirtable,
  siAtlassian,
  siClickup,
  siCloudflare,
  siHuggingface,
  siIntercom,
  siLinear,
  siNeon,
  siNetlify,
  siNotion,
  siPaypal,
  siPosthog,
  siPrisma,
  siSentry,
  siSquare,
  siStripe,
  siSupabase,
  siVercel,
  siWebflow,
  siWix,
  siZapier,
} from 'simple-icons';

/** What an app is filed under, in the category list; the order here is the list's. */
export const CATEGORIES = {
  development: 'Development',
  projects: 'Projects',
  productivity: 'Productivity',
  design: 'Design and sites',
  payments: 'Payments',
  customers: 'Customers',
  social: 'Social',
} as const;
export type Category = keyof typeof CATEGORIES;

/**
 * An app that is the service's own hosted MCP server under a card: Connect saves it as an MCP
 * server and signs in with OAuth. Every one here was checked to offer dynamic client
 * registration (RFC 7591), which is what lets the gateway sign in with no client id to paste;
 * one that needs a pre-registered client (Asana, HubSpot, Box) belongs on the MCP servers page.
 */
export type McpApp = {
  /** Also the MCP server's name, so it follows that name's rule. */
  id: string;
  name: string;
  description: string;
  category: Category;
  url: string;
  /** From Simple Icons; an app it lacks shows its initial. */
  icon?: SimpleIcon;
};

export const MCP_APPS: McpApp[] = [
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects and cycles in your Linear workspace.',
    category: 'projects',
    url: 'https://mcp.linear.app/mcp',
    icon: siLinear,
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    description: 'Jira issues and Confluence pages.',
    category: 'projects',
    url: 'https://mcp.atlassian.com/v1/mcp',
    icon: siAtlassian,
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    description: 'Tasks, lists and docs in your ClickUp workspace.',
    category: 'projects',
    url: 'https://mcp.clickup.com/mcp',
    icon: siClickup,
  },
  {
    id: 'monday',
    name: 'monday.com',
    description: 'Boards, items and updates on monday.com.',
    category: 'projects',
    url: 'https://mcp.monday.com/mcp',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and write pages and databases in Notion.',
    category: 'productivity',
    url: 'https://mcp.notion.com/mcp',
    icon: siNotion,
  },
  {
    id: 'airtable',
    name: 'Airtable',
    description: 'Bases, tables and records in Airtable.',
    category: 'productivity',
    url: 'https://mcp.airtable.com/mcp',
    icon: siAirtable,
  },
  {
    id: 'zapier',
    name: 'Zapier',
    description: 'The actions you set up on Zapier, across the apps it connects.',
    category: 'productivity',
    url: 'https://mcp.zapier.com/api/mcp/mcp',
    icon: siZapier,
  },
  {
    id: 'canva',
    name: 'Canva',
    description: 'Find, create and export designs in Canva.',
    category: 'design',
    url: 'https://mcp.canva.com/mcp',
  },
  {
    id: 'webflow',
    name: 'Webflow',
    description: 'Sites, pages and CMS collections on Webflow.',
    category: 'design',
    url: 'https://mcp.webflow.com/mcp',
    icon: siWebflow,
  },
  {
    id: 'wix',
    name: 'Wix',
    description: 'Sites, content and business data on Wix.',
    category: 'design',
    url: 'https://mcp.wix.com/mcp',
    icon: siWix,
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Customers, payments, invoices and subscriptions on Stripe.',
    category: 'payments',
    url: 'https://mcp.stripe.com',
    icon: siStripe,
  },
  {
    id: 'paypal',
    name: 'PayPal',
    description: 'Invoices, orders and transactions on PayPal.',
    category: 'payments',
    url: 'https://mcp.paypal.com/mcp',
    icon: siPaypal,
  },
  {
    id: 'square',
    name: 'Square',
    description: 'Payments, orders, catalog and customers on Square.',
    category: 'payments',
    url: 'https://mcp.squareup.com/mcp',
    icon: siSquare,
  },
  {
    id: 'intercom',
    name: 'Intercom',
    description: 'Conversations, contacts and help articles in Intercom.',
    category: 'customers',
    url: 'https://mcp.intercom.com/mcp',
    icon: siIntercom,
  },
  {
    id: 'attio',
    name: 'Attio',
    description: 'Companies, people and deals in your Attio CRM.',
    category: 'customers',
    url: 'https://mcp.attio.com/mcp',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Errors, issues and releases from Sentry.',
    category: 'development',
    url: 'https://mcp.sentry.dev/mcp',
    icon: siSentry,
  },
  {
    id: 'posthog',
    name: 'PostHog',
    description: 'Product analytics, feature flags and experiments on PostHog.',
    category: 'development',
    url: 'https://mcp.posthog.com/mcp',
    icon: siPosthog,
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Projects, deployments and their logs on Vercel.',
    category: 'development',
    url: 'https://mcp.vercel.com',
    icon: siVercel,
  },
  {
    id: 'netlify',
    name: 'Netlify',
    description: 'Sites, deploys and their settings on Netlify.',
    category: 'development',
    url: 'https://mcp.netlify.com/mcp',
    icon: siNetlify,
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Your Cloudflare account through its API: Workers, DNS, storage and more.',
    category: 'development',
    url: 'https://mcp.cloudflare.com/mcp',
    icon: siCloudflare,
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Projects, databases, functions and logs on Supabase.',
    category: 'development',
    url: 'https://mcp.supabase.com/mcp',
    icon: siSupabase,
  },
  {
    id: 'neon',
    name: 'Neon',
    description: 'Postgres projects, branches and queries on Neon.',
    category: 'development',
    url: 'https://mcp.neon.tech/mcp',
    icon: siNeon,
  },
  {
    id: 'prisma',
    name: 'Prisma Postgres',
    description: 'Prisma Postgres databases, their schema and backups.',
    category: 'development',
    url: 'https://mcp.prisma.io/mcp',
    icon: siPrisma,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Models, datasets, Spaces and papers on Hugging Face.',
    category: 'development',
    url: 'https://huggingface.co/mcp',
    icon: siHuggingface,
  },
];

/** The same address however it was typed: a trailing slash makes no other server. */
const same = (a: string | undefined, b: string) =>
  Boolean(a) && a?.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** The saved server that is this app, by its address: a server the owner added by hand counts. */
export function serverOf<T extends { url?: string | undefined }>(app: McpApp, servers: T[]) {
  return servers.find((server) => same(server.url, app.url));
}

/** The app's own name, or the first free one after it, so Connect never replaces a server. */
export function freeName(app: McpApp, taken: string[]) {
  if (!taken.includes(app.id)) return app.id;
  for (let count = 2; ; count += 1) {
    const name = `${app.id.slice(0, 27)}_${count}`;
    if (!taken.includes(name)) return name;
  }
}
