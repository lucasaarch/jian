import {
  type SimpleIcon,
  siAirtable,
  siAtlassian,
  siBuildkite,
  siCaldotcom,
  siCalendly,
  siClickup,
  siCloudflare,
  siDropbox,
  siExpo,
  siGitlab,
  siHostinger,
  siHuggingface,
  siIntercom,
  siLinear,
  siMake,
  siMercadopago,
  siMiro,
  siMixpanel,
  siNeon,
  siNetlify,
  siNotion,
  siPaypal,
  siPosthog,
  siPostman,
  siPrisma,
  siRailway,
  siResend,
  siSanity,
  siSentry,
  siSquare,
  siStripe,
  siSupabase,
  siTodoist,
  siTrello,
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
  /**
   * Where the app's server used to be. A server saved there before the app moved is still this
   * app, or it would drop out of its card and back onto the MCP servers page as a stranger.
   */
  formerUrls?: string[];
  icon: AppMark;
};

/**
 * An app's mark, one path drawn in the text colour. Simple Icons has most; one it lacks is drawn
 * here from an openly licensed set, with its own `viewBox` when it is not the 24 unit square.
 */
type AppMark = Pick<SimpleIcon, 'path'> & { viewBox?: string };

/** AWS, from Boxicons Brands (MIT): Simple Icons no longer carries it. */
const awsMark: AppMark = {
  path: 'M18.75 11.35a4.32 4.32 0 0 1-.79-.08 3.9 3.9 0 0 1-.73-.23l-.17-.04h-.12q-.15 0-.15.21v.33a.43.43 0 0 0 0 .19.5.5 0 0 0 .21.19 3 3 0 0 0 .76.26 4.38 4.38 0 0 0 1 .12 3 3 0 0 0 1-.14 1.94 1.94 0 0 0 .73-.37 1.81 1.81 0 0 0 .49-.58 1.79 1.79 0 0 0 .17-.78 1.54 1.54 0 0 0-.3-.93 2.15 2.15 0 0 0-1-.64l-.95-.3a2 2 0 0 1-.73-.36.65.65 0 0 1-.2-.47.66.66 0 0 1 .31-.6 1.82 1.82 0 0 1 .89-.18 2.89 2.89 0 0 1 1.27.26.79.79 0 0 0 .26.08c.1 0 .15-.08.15-.22v-.36a.38.38 0 0 0-.06-.22.56.56 0 0 0-.2-.16 1.55 1.55 0 0 0-.28-.12 3.44 3.44 0 0 0-.38-.11l-.44-.1A3.4 3.4 0 0 0 19 6a2.82 2.82 0 0 0-.83.11 2.19 2.19 0 0 0-.7.35A1.61 1.61 0 0 0 17 7a1.5 1.5 0 0 0-.18.74 1.6 1.6 0 0 0 .33 1 2.08 2.08 0 0 0 1.06.68l1 .3a1.58 1.58 0 0 1 .67.34.66.66 0 0 1 .18.47.72.72 0 0 1-.35.63 1.83 1.83 0 0 1-.96.19zM12.94 6.5a.48.48 0 0 0-.13-.26.37.37 0 0 0-.26-.07H12a.43.43 0 0 0-.26.07.42.42 0 0 0-.13.26l-1 4.4-1.14-4.4a.48.48 0 0 0-.14-.26s-.13-.07-.26-.07h-.65c-.11 0-.16.06-.16.17a1.22 1.22 0 0 0 .06.27l1.56 5.14A.61.61 0 0 0 10 12a.45.45 0 0 0 .26.06h.57a.49.49 0 0 0 .27-.06.57.57 0 0 0 .12-.27l1-4.28 1 4.29a.42.42 0 0 0 .12.26.4.4 0 0 0 .27.07h.57a.41.41 0 0 0 .25-.07.44.44 0 0 0 .14-.26l1.61-5.14a.73.73 0 0 0 0-.16.52.52 0 0 0 0-.11.15.15 0 0 0-.17-.17h-.62a.45.45 0 0 0-.26.07.68.68 0 0 0-.13.26L14 11zM5.77 8.63a5.92 5.92 0 0 0-.71-.05 2.42 2.42 0 0 0-1.63.52 1.72 1.72 0 0 0-.6 1.37 1.7 1.7 0 0 0 .49 1.28 1.82 1.82 0 0 0 1.33.48 2.48 2.48 0 0 0 2-.92 3.5 3.5 0 0 0 .2.39 2.34 2.34 0 0 0 .24.31.26.26 0 0 0 .37 0l.42-.28a.28.28 0 0 0 .13-.2.27.27 0 0 0 0-.16 3.63 3.63 0 0 1-.21-.47 2 2 0 0 1-.07-.6V8.19a2.2 2.2 0 0 0-.55-1.64A2.42 2.42 0 0 0 5.33 6a3.9 3.9 0 0 0-1 .13 3.9 3.9 0 0 0-.84.3.47.47 0 0 0-.18.14.37.37 0 0 0 0 .23v.33c0 .14 0 .2.14.2a.26.26 0 0 0 .11 0l.23-.08A4.32 4.32 0 0 1 4.42 7a3 3 0 0 1 .72-.09 1.5 1.5 0 0 1 1.08.31 1.46 1.46 0 0 1 .31 1.06v.49zm.78.9v.27a2.36 2.36 0 0 1-.07.58 1.06 1.06 0 0 1-.23.43 1.38 1.38 0 0 1-.63.42 2.12 2.12 0 0 1-.68.12.94.94 0 0 1-.7-.24.92.92 0 0 1-.24-.71.92.92 0 0 1 .33-.76 1.52 1.52 0 0 1 1-.27h.62a5.67 5.67 0 0 1 .6.16zM19.76 15a19.68 19.68 0 0 1-7.55 1.54 20 20 0 0 1-9.9-2.62c-.24-.15-.43.1-.22.29A14.68 14.68 0 0 0 12 18a14.4 14.4 0 0 0 8.1-2.47c.34-.31.03-.72-.34-.53z M18.38 14.06c-.19.14-.16.33.05.3.71-.09 2.28-.27 2.56.09s-.31 1.83-.58 2.49c-.08.2.1.28.28.13a3.9 3.9 0 0 0 1.23-3.34 3.94 3.94 0 0 0-3.54.33z',
};

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
    description: 'Jira, Confluence, Compass and Bitbucket in your Atlassian organization.',
    category: 'projects',
    url: 'https://mcp.atlassian.com/v2/mcp',
    formerUrls: ['https://mcp.atlassian.com/v1/mcp'],
    icon: siAtlassian,
  },
  {
    id: 'trello',
    name: 'Trello',
    description: 'Boards, lists and cards in your Trello workspaces.',
    category: 'projects',
    url: 'https://mcp.trello.com/v1',
    icon: siTrello,
  },
  {
    id: 'todoist',
    name: 'Todoist',
    description: 'Tasks, projects and due dates in Todoist.',
    category: 'projects',
    url: 'https://ai.todoist.net/mcp',
    icon: siTodoist,
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
    id: 'make',
    name: 'Make',
    description: 'Scenarios in your Make organization, run as tools.',
    category: 'productivity',
    url: 'https://mcp.make.com',
    icon: siMake,
  },
  {
    id: 'calendly',
    name: 'Calendly',
    description: 'Event types, scheduled meetings and availability in Calendly.',
    category: 'productivity',
    url: 'https://mcp.calendly.com',
    icon: siCalendly,
  },
  {
    id: 'cal_com',
    name: 'Cal.com',
    description: 'Bookings, event types and availability on Cal.com.',
    category: 'productivity',
    url: 'https://mcp.cal.com/mcp',
    icon: siCaldotcom,
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    description: 'Files and folders in your Dropbox.',
    category: 'productivity',
    url: 'https://mcp.dropbox.com/mcp',
    icon: siDropbox,
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
    id: 'miro',
    name: 'Miro',
    description: 'Boards, their items and diagrams in Miro.',
    category: 'design',
    url: 'https://mcp.miro.com/',
    icon: siMiro,
  },
  {
    id: 'sanity',
    name: 'Sanity',
    description: 'Documents, schemas and datasets in your Sanity projects.',
    category: 'design',
    url: 'https://mcp.sanity.io',
    icon: siSanity,
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
    id: 'mercado_pago',
    name: 'Mercado Pago',
    description: 'Mercado Pago applications and credentials, webhooks, test users and the docs.',
    category: 'payments',
    url: 'https://mcp.mercadopago.com/mcp',
    icon: siMercadopago,
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
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Projects, issues, merge requests and pipelines on GitLab.com.',
    category: 'development',
    url: 'https://gitlab.com/api/v4/mcp',
    icon: siGitlab,
  },
  {
    id: 'aws',
    name: 'AWS',
    description: 'AWS services through their APIs, as your IAM permissions allow, and the docs.',
    category: 'development',
    // The query has AWS answer a call with no token by asking for sign-in, which is what starts
    // it here; without it the first call is answered and sign-in never begins.
    url: 'https://aws-mcp.us-east-1.api.aws/mcp?oauth=initialize',
    icon: awsMark,
  },
  {
    id: 'railway',
    name: 'Railway',
    description: 'Projects, services, deployments and logs on Railway.',
    category: 'development',
    url: 'https://mcp.railway.com',
    icon: siRailway,
  },
  {
    id: 'hostinger',
    name: 'Hostinger',
    description: 'VPS, domains, DNS, hosting, billing and email marketing at Hostinger.',
    category: 'development',
    url: 'https://mcp.hostinger.com',
    icon: siHostinger,
  },
  {
    id: 'expo',
    name: 'Expo',
    description: 'EAS builds and workflows, store crashes and reviews, and the Expo docs.',
    category: 'development',
    url: 'https://mcp.expo.dev/mcp',
    icon: siExpo,
  },
  {
    id: 'resend',
    name: 'Resend',
    description: 'Emails, domains, audiences and broadcasts in Resend.',
    category: 'development',
    url: 'https://mcp.resend.com/mcp',
    icon: siResend,
  },
  {
    id: 'postman',
    name: 'Postman',
    description: 'Workspaces, collections, environments and APIs in Postman.',
    category: 'development',
    url: 'https://mcp.postman.com/mcp',
    icon: siPostman,
  },
  {
    id: 'buildkite',
    name: 'Buildkite',
    description: 'Pipelines, builds and job logs on Buildkite.',
    category: 'development',
    url: 'https://mcp.buildkite.com/mcp',
    icon: siBuildkite,
  },
  {
    id: 'mixpanel',
    name: 'Mixpanel',
    description: 'Events, reports and funnels in your Mixpanel projects.',
    category: 'development',
    url: 'https://mcp.mixpanel.com/mcp',
    icon: siMixpanel,
  },
];

/** The same address however it was typed: a trailing slash makes no other server. */
const same = (a: string | undefined, b: string) =>
  Boolean(a) && a?.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** Whether an address is this app's, now or before it moved. */
const isAt = (app: McpApp, url: string | undefined) =>
  [app.url, ...(app.formerUrls ?? [])].some((known) => same(url, known));

/** The saved server that is this app, by its address: a server the owner added by hand counts. */
export function serverOf<T extends { url?: string | undefined }>(app: McpApp, servers: T[]) {
  return servers.find((server) => isAt(app, server.url));
}

/**
 * Whether a saved server is one of these apps. Its card in Apps is all there is of it: the MCP
 * servers page leaves it out.
 */
export const isAppServer = (server: { url?: string | undefined }) =>
  MCP_APPS.some((app) => isAt(app, server.url));

/** The app's own name, or the first free one after it, so Connect never replaces a server. */
export function freeName(app: McpApp, taken: string[]) {
  if (!taken.includes(app.id)) return app.id;
  for (let count = 2; ; count += 1) {
    const name = `${app.id.slice(0, 27)}_${count}`;
    if (!taken.includes(name)) return name;
  }
}
