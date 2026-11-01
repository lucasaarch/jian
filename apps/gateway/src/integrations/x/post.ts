import { z } from 'zod';
import type { XActor, XClient } from './client.js';
import { XFailure } from './failures.js';
import { uploadMedia } from './media.js';

/** A post's own parts; the first and every later one of a thread take them alike. */
const postParts = {
  text: z.string().min(1).optional().describe('The words. Required unless there is media.'),
  media: z
    .array(z.string().min(1))
    .max(4)
    .optional()
    .describe(
      'Up to 4 photos, or 1 GIF or video: media IDs from this conversation, or IDs from x_upload_media.',
    ),
};

export const xPostInput = {
  ...postParts,
  reply_to: z.string().min(1).optional().describe('The post this one answers.'),
  thread: z
    .array(z.object(postParts))
    .max(24)
    .optional()
    .describe('More posts after this one, each answering the one before it.'),
  quote_post_id: z.string().optional(),
  poll: z
    .object({
      options: z.array(z.string().min(1).max(25)).min(2).max(4),
      duration_minutes: z.number().int().min(5).max(10080),
    })
    .optional(),
  reply_settings: z.enum(['following', 'mentionedUsers', 'subscribers', 'verified']).optional(),
  community_id: z.string().optional(),
  edit_post_id: z.string().optional().describe('Edit this post of yours instead of a new one.'),
  place_id: z.string().optional(),
  made_with_ai: z.boolean().optional().describe('Discloses that the media was made with AI.'),
  paid_partnership: z.boolean().optional(),
  for_super_followers_only: z.boolean().optional(),
};

export const X_POST_ABOUT =
  'Post on X: one post, a reply, or a thread. Each post costs the app credit, and a post with a link in it costs far more ($0.20 against $0.015 when this was written). Leave a link out unless it is the point. Never claim a post went out before this confirms it.';

type Part = { text?: string | undefined; media?: string[] | undefined };
type XPostInput = Part & {
  reply_to?: string | undefined;
  thread?: Part[] | undefined;
  quote_post_id?: string | undefined;
  poll?: { options: string[]; duration_minutes: number } | undefined;
  reply_settings?: string | undefined;
  community_id?: string | undefined;
  edit_post_id?: string | undefined;
  place_id?: string | undefined;
  made_with_ai?: boolean | undefined;
  paid_partnership?: boolean | undefined;
  for_super_followers_only?: boolean | undefined;
};

const OPTIONAL = [
  'quote_tweet_id',
  'poll',
  'reply_settings',
  'community_id',
  'made_with_ai',
  'paid_partnership',
  'for_super_followers_only',
] as const;

const JIAN_MEDIA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type XPostDeps = {
  client: Pick<XClient, 'call'>;
  /** A file of this agent's, by the ID the conversation knows it by. */
  readMedia: (id: string) => Promise<{ bytes: Buffer; mimeType: string }>;
};

/** What a thread that stopped halfway has out in the world, so nobody posts it twice. */
const halfway = (posted: { id: string }[], index: number, total: number, reason: string) =>
  [
    `Post ${index + 1} of ${total} did not go out: ${reason}`,
    posted.length
      ? `Already public, and not to be posted again: ${posted.map(({ id }) => id).join(', ')}.`
      : 'None of them went out.',
  ].join(' ');

/**
 * Posts one post or a thread in order, each replying to the last. Media goes up first, for the whole
 * thread: a file X rejects should stop the thread before anything is public. A post that fails ends
 * it there, and what already went out is reported rather than undone.
 */
export async function publish(
  deps: XPostDeps,
  account: XActor,
  input: XPostInput,
  signal?: AbortSignal,
) {
  const parts = [{ text: input.text, media: input.media }, ...(input.thread ?? [])];

  for (const part of parts) {
    if (!part.text && !part.media?.length) {
      throw new XFailure(400, 'A post needs words or media.');
    }
  }

  // Scopes are enforced per call; media.write only matters when something is uploaded.
  const uploaded: string[][] = [];

  for (const part of parts) {
    const ids: string[] = [];

    for (const id of part.media ?? []) {
      ids.push(
        JIAN_MEDIA.test(id)
          ? await uploadMedia(deps.client, account, await deps.readMedia(id), 'post', signal)
          : id,
      );
    }
    uploaded.push(ids);
  }

  const options: Record<string, unknown> = {
    quote_tweet_id: input.quote_post_id,
    poll: input.poll,
    reply_settings: input.reply_settings,
    community_id: input.community_id,
    made_with_ai: input.made_with_ai,
    paid_partnership: input.paid_partnership,
    for_super_followers_only: input.for_super_followers_only,
  };
  const posted: { id: string; text?: string; url: string }[] = [];
  let replyTo = input.reply_to;

  for (const [index, part] of parts.entries()) {
    const ids = uploaded[index] ?? [];
    const body: Record<string, unknown> = {
      ...(part.text ? { text: part.text } : {}),
      ...(ids.length ? { media: { media_ids: ids } } : {}),
      ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}),
    };

    // The extras describe the post they were written for: the first of a thread.
    if (index === 0) {
      for (const name of OPTIONAL) {
        if (options[name] !== undefined) body[name] = options[name];
      }
      if (input.edit_post_id) body.edit_options = { previous_post_id: input.edit_post_id };
      if (input.place_id) body.geo = { place_id: input.place_id };
    }

    try {
      const answer = (await deps.client.call(account, {
        method: 'POST',
        path: '/2/tweets',
        body,
        scopes: ['tweet.read', 'tweet.write', 'users.read'],
        acts: true,
        signal,
      })) as { data?: { id?: string; text?: string } };
      const id = answer.data?.id;

      if (!id) throw new XFailure(502, 'X answered without the new post.');

      posted.push({
        id,
        ...(answer.data?.text ? { text: answer.data.text } : {}),
        url: `https://x.com/${account.handle}/status/${id}`,
      });
      replyTo = id;
    } catch (error) {
      // A lone post that failed is a plain failure; only a thread has something to account for.
      if (parts.length === 1 || !(error instanceof XFailure)) throw error;

      throw new XFailure(error.statusCode, halfway(posted, index, parts.length, error.message));
    }
  }

  return { account: account.handle, posted };
}
