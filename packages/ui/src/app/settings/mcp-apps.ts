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
  icon: AppMark;
};

/**
 * An app's mark, one path drawn in the text colour. Simple Icons has most; one it lacks is drawn
 * here from an openly licensed set, with its own `viewBox` when it is not the 24 unit square.
 */
export type AppMark = Pick<SimpleIcon, 'path'> & { viewBox?: string };

/** Canva, from Boxicons Brands (MIT). */
const canvaMark: AppMark = {
  path: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2m-.39 16.5c-2.95 0-4.86-2.21-4.86-5.56c0-4.32 2.99-7.45 6.36-7.45c2.04 0 3.25 1.03 3.25 2.42s-1.04 2.46-1.93 2.46c-.22 0-.33-.11-.33-.29c0-.4.64-1 .64-2.13c0-.95-.58-1.55-1.53-1.55c-2.04 0-4.36 2.41-4.36 6.58c0 2.46 1.22 4.24 3.19 4.24c1.71 0 3.18-1.22 4.03-2.96c.08-.15.15-.22.23-.22c.12 0 .23.1.23.33c0 1.01-1.81 4.12-4.94 4.12Z',
};

/** monday.com, from SVG Logos (CC0), its two strokes and its dot in one colour. */
const mondayMark: AppMark = {
  viewBox: '0 -50 256 256',
  path: 'M31.846 153.489a31.97 31.97 0 0 1-27.86-16.167a30.91 30.91 0 0 1 .875-31.823l57.373-90.096A31.99 31.99 0 0 1 90.556.015a31.93 31.93 0 0 1 27.41 16.896c5.349 10.113 4.68 22.28-1.725 31.774L58.904 138.78a31.98 31.98 0 0 1-27.058 14.709M130.256 153.488c-11.572 0-22.22-6.187-27.812-16.13a30.81 30.81 0 0 1 .875-31.737l57.264-89.89A31.94 31.94 0 0 1 188.93.016c11.669.255 22.244 6.782 27.592 16.993a30.81 30.81 0 0 1-2.066 31.92l-57.252 89.889a31.93 31.93 0 0 1-26.948 14.671M196.928 125.324a29.538 28.918 0 1 0 59.076 0a29.538 28.918 0 1 0-59.076 0',
};

/** Attio, from theSVG (MIT). */
const attioMark: AppMark = {
  viewBox: '0 -2 32 32',
  path: 'm31.669 19.175l-2.673-4.279l-.016-.026l-.211-.336a2.16 2.16 0 0 0-1.838-1.022l-4.306-.014l-.3.481l-5.146 8.235l-.284.456l2.156 3.444a2.15 2.15 0 0 0 1.843 1.023h6.035a2.19 2.19 0 0 0 1.842-1.02l.213-.34s.008-.01.01-.015l2.677-4.284c.44-.7.44-1.605 0-2.303zm-.816 1.792l-2.677 4.284l-.037.052a.363.363 0 0 1-.579-.054l-2.678-4.284a1.2 1.2 0 0 1-.137-.969c.03-.105.076-.21.135-.306l2.674-4.28l.006-.01a.34.34 0 0 1 .213-.154q.04-.01.071-.014h.03c.062 0 .215.02.31.176l2.674 4.278c.244.39.244.891 0 1.28zM23.758 8.823a2.19 2.19 0 0 0 0-2.303l-2.673-4.278l-.223-.36a2.16 2.16 0 0 0-1.844-1.02h-6.034c-.754 0-1.442.381-1.844 1.022L.333 19.178a2.16 2.16 0 0 0-.002 2.301L3.23 26.12c.4.64 1.088 1.02 1.842 1.02h6.035c.758 0 1.446-.381 1.844-1.022l.22-.35v-.004s.005-.006.005-.008l2.154-3.445l6.384-10.218l2.041-3.268zm-.63-1.151c0 .22-.062.443-.187.64L12.355 25.255a.36.36 0 0 1-.31.17a.36.36 0 0 1-.31-.17l-2.676-4.286a1.22 1.22 0 0 1 0-1.28L19.645 2.752a.36.36 0 0 1 .31-.173c.062 0 .215.018.313.175L22.94 7.03c.125.197.187.42.187.64',
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
    icon: mondayMark,
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
    icon: canvaMark,
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
    icon: attioMark,
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

/**
 * Whether a saved server is one of these apps. Its card in Apps is all there is of it: the MCP
 * servers page leaves it out.
 */
export const isAppServer = (server: { url?: string | undefined }) =>
  MCP_APPS.some((app) => same(server.url, app.url));

/** The app's own name, or the first free one after it, so Connect never replaces a server. */
export function freeName(app: McpApp, taken: string[]) {
  if (!taken.includes(app.id)) return app.id;
  for (let count = 2; ; count += 1) {
    const name = `${app.id.slice(0, 27)}_${count}`;
    if (!taken.includes(name)) return name;
  }
}
