import { z } from 'zod';
import { op, type XOperation } from './row.js';

export const platformOperations: XOperation[] = [
  op(
    'x_developer_account',
    'GET /2/account',
    "Returns the authenticated user's X Developer Platform account.",
    'developer.read',
  ),
  op(
    'x_ensure_developer_account',
    'POST /2/account',
    'Creates an X Developer Platform account for the authenticated user if they do not already have one, and returns it.',
    'developer.write',
    {
      kind: 'service',
      body: {
        metadata: z
          .string()
          .optional()
          .describe('Optional provisioning-credit metadata (an opaque string, e.g.'),
      },
    },
  ),
  op(
    'x_check_account_activity',
    'GET /2/account_activity/webhooks/{webhook_id}/subscriptions/all',
    "Checks a user's Account Activity subscription for a given webhook.",
    'dm.read dm.write tweet.read users.read',
  ),
  op(
    'x_subscribe_account_activity',
    'POST /2/account_activity/webhooks/{webhook_id}/subscriptions/all',
    'Creates an Account Activity subscription for the user and the given webhook.',
    'dm.read dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_activity_subscriptions',
    'GET /2/activity/subscriptions',
    'Get a list of active subscriptions for XAA.',
    'like.read tweet.read',
    {
      query: {
        max_results: z.number().int().min(1).max(1000).default(10),
        pagination_token: z.string().optional(),
        user_id: z
          .string()
          .optional()
          .describe('Only return subscriptions whose filter.user_id matches.'),
      },
    },
  ),
  op(
    'x_create_activity_subscription',
    'POST /2/activity/subscriptions',
    'Creates a subscription for an X activity event.',
    '',
    {
      kind: 'service',
      body: {
        event_type: z
          .enum([
            'profile.update.bio',
            'profile.update.profile_picture',
            'profile.update.banner_picture',
            'profile.update.screenname',
            'profile.update.geo',
            'profile.update.url',
            'profile.update.verified_badge',
            'profile.update.affiliate_badge',
            'profile.update.handle',
            'news.new',
            'follow.follow',
            'follow.unfollow',
            'subscriptions.subscribe',
            'subscriptions.unsubscribe',
            'spaces.start',
            'spaces.end',
            'broadcast.start',
            'broadcast.end',
            'broadcast.chat',
            'broadcast.chat.remove',
            'chat.received',
            'chat.sent',
            'chat.conversation.join',
            'chat.conversation_join',
            'chat.conversation.member_added',
            'chat.conversation.member_removed',
            'chat.conversation.admin_added',
            'chat.conversation.admin_removed',
            'chat.update.group_name',
            'chat.update.restrictions',
            'dm.sent',
            'dm.received',
            'dm.indicate_typing',
            'dm.read',
            'post.create',
            'post.delete',
            'post.mention.create',
            'post.reply.create',
            'post.quote.create',
            'post.repost.create',
            'like.create',
            'mute.mute',
            'mute.unmute',
            'block.block',
            'block.unblock',
          ])
          .describe('Activity event type in dot notation.'),
        expires_at: z.string().optional().describe('Optional RFC 3339 expiration time.'),
        filter: z
          .object({
            direction: z
              .enum(['inbound', 'outbound'])
              .optional()
              .describe('Optional direction filter for directional events.'),
            keyword: z.string().optional().describe('Optional keyword filter.'),
            qualifiers: z
              .looseObject({})
              .optional()
              .describe('Optional event-specific string predicates.'),
            user_id: z.string().optional().describe('User the subscription is scoped to.'),
          })
          .describe('Subscription filter.'),
        tag: z.string().optional().describe('Optional caller-defined tag.'),
        webhook_id: z
          .string()
          .optional()
          .describe('Webhook to deliver the subscription events to.'),
      },
    },
  ),
  op(
    'x_delete_activity_subscription',
    'DELETE /2/activity/subscriptions/{subscription_id}',
    'Deletes a subscription for an X activity event',
    '',
    { kind: 'service' },
  ),
  op(
    'x_update_activity_subscription',
    'PUT /2/activity/subscriptions/{subscription_id}',
    'Updates a subscription for an X activity event',
    '',
    {
      kind: 'service',
      body: {
        tag: z.string().optional().describe('Optional caller-defined tag.'),
        webhook_id: z
          .string()
          .optional()
          .describe('Webhook to deliver the subscription events to.'),
      },
    },
  ),
  op('x_credits', 'GET /2/usage/credits', "Read the developer app's credit balance in USD.", ''),
  op(
    'x_webhooks',
    'GET /2/webhooks',
    'Get a list of webhook configs associated with a client app.',
    '',
    { preset: { 'webhook_config.fields': 'created_at,id,url,valid' } },
  ),
  op('x_create_webhook', 'POST /2/webhooks', 'Creates a new webhook configuration.', '', {
    kind: 'service',
    body: { url: z.string().describe('The URL the webhook delivers events to.') },
  }),
  op(
    'x_delete_webhook',
    'DELETE /2/webhooks/{webhook_id}',
    'Deletes an existing webhook configuration.',
    '',
    { kind: 'service' },
  ),
  op(
    'x_check_webhook',
    'PUT /2/webhooks/{webhook_id}',
    'Triggers a CRC check for a given webhook.',
    '',
    { kind: 'service' },
  ),
];
