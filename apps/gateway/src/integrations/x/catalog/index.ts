import { discoverOperations } from './discover.js';
import { listsOperations } from './lists.js';
import { liveOperations } from './live.js';
import { mediaOperations } from './media.js';
import { messagesOperations } from './messages.js';
import { peopleOperations } from './people.js';
import { platformOperations } from './platform.js';
import { postsOperations } from './posts.js';
import type { XActionKind, XOperation } from './row.js';

export type { XActionKind, XCharge, XOperation } from './row.js';

/** The tools written by hand, for what takes more than one call of X's. */
const HANDWRITTEN = {
  x_post: {
    kind: 'service',
    scopes: ['media.write', 'tweet.read', 'tweet.write', 'users.read'],
    about: 'Post on X',
  },
  x_upload_media: {
    kind: 'service',
    scopes: ['media.write'],
    about: 'Upload media to X',
  },
  x_download_dm_media: {
    scopes: ['dm.read'],
    about: 'Download media from a direct message on X',
  },
} as const satisfies Record<string, { kind?: XActionKind; scopes: string[]; about: string }>;

export const X_OPERATIONS: readonly XOperation[] = [
  ...postsOperations,
  ...mediaOperations,
  ...peopleOperations,
  ...listsOperations,
  ...messagesOperations,
  ...liveOperations,
  ...discoverOperations,
  ...platformOperations,
];

const names = (operations: readonly XOperation[]) => operations.map(({ name }) => name);

/**
 * So many tools cannot be sent on every turn: each theme is a group `load_tools` brings in when the
 * agent needs it, and only a run with a linked account is offered them at all.
 */
export const X_TOOL_GROUPS = {
  x_posts: {
    summary:
      'on X: post, reply, thread, delete; read mentions, timelines, posts and search; like, repost and bookmark',
    tools: ['x_post', ...names(postsOperations)] as readonly string[],
  },
  x_media: {
    summary: 'on X: upload media ahead of a post, set alt text and subtitles, read media analytics',
    tools: ['x_upload_media', ...names(mediaOperations)] as readonly string[],
  },
  x_people: {
    summary: 'on X: look up and search accounts; follow, block and mute; followers and following',
    tools: names(peopleOperations) as readonly string[],
  },
  x_lists: {
    summary: 'on X: create and manage Lists, their members and followers, read their posts',
    tools: names(listsOperations) as readonly string[],
  },
  x_messages: {
    summary:
      'on X: send and read direct messages; manage Chat conversations, groups and settings (Chat message contents are encrypted and out of reach)',
    tools: ['x_download_dm_media', ...names(messagesOperations)] as readonly string[],
  },
  x_live: {
    summary: 'on X: Spaces, live broadcasts with their chat and sources, and X calls',
    tools: names(liveOperations) as readonly string[],
  },
  x_discover: {
    summary: 'on X: trends, news, Communities and Community Notes',
    tools: names(discoverOperations) as readonly string[],
  },
  x_platform: {
    summary:
      "on X: the developer app's credit balance, developer account, webhooks and activity subscriptions",
    tools: names(platformOperations) as readonly string[],
  },
};

/** What a tool of X's changes, for the guard. Reads are absent, and never ask. */
export const X_ACTION_KINDS: Record<string, XActionKind> = Object.fromEntries([
  ...X_OPERATIONS.flatMap(({ name, kind }) => (kind ? [[name, kind] as const] : [])),
  ...Object.entries(HANDWRITTEN).flatMap(([name, entry]) =>
    'kind' in entry ? [[name, entry.kind] as const] : [],
  ),
]);

const ABOUT = new Map<string, string>([
  ...X_OPERATIONS.map(({ name, about }) => [name, about] as const),
  ...Object.entries(HANDWRITTEN).map(([name, { about }]) => [name, about] as const),
]);

/** A tool of X's by its name, whether from the table or written by hand. */
export const isXTool = (name: string) => ABOUT.has(name);

/** Whether a result came from X and not from the gateway: posts, profiles, messages by others. */
export const readsFromX = (name: string) => isXTool(name) && !X_ACTION_KINDS[name];

/** What an approval card says of a call when the model could not write it. */
export function xActionTitle(name: string, account: unknown): string {
  const about = (ABOUT.get(name) ?? 'Act on X').replace(/\.$/, '');

  return typeof account === 'string' && account ? `@${account}: ${about}` : about;
}

/**
 * Every scope an account is asked for: what the tools above need, and nothing that no tool uses.
 * `offline.access` is what makes X issue a refresh token at all.
 */
export const X_SCOPES: readonly string[] = [
  ...new Set([
    'offline.access',
    ...X_OPERATIONS.flatMap(({ scopes }) => scopes),
    ...Object.values(HANDWRITTEN).flatMap(({ scopes }) => scopes),
  ]),
].sort();

export const X_HANDWRITTEN_SCOPES = {
  x_upload_media: [...HANDWRITTEN.x_upload_media.scopes],
  x_download_dm_media: [...HANDWRITTEN.x_download_dm_media.scopes],
};
