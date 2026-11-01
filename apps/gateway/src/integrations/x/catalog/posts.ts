import { z } from 'zod';
import { op, type XOperation } from './row.js';

export const postsOperations: XOperation[] = [
  op(
    'x_create_article_draft',
    'POST /2/articles/draft',
    'Create an Article draft to publish later.',
    '',
    {
      kind: 'service',
      body: {
        content_state: z
          .object({
            blocks: z
              .array(
                z.object({
                  data: z
                    .object({
                      cashtags: z
                        .array(z.looseObject({}))
                        .optional()
                        .describe('Cashtag spans in this block.'),
                      hashtags: z
                        .array(z.looseObject({}))
                        .optional()
                        .describe('Hashtag spans in this block.'),
                      mentions: z
                        .array(z.looseObject({}))
                        .optional()
                        .describe('Mention spans in this block.'),
                      urls: z
                        .array(z.looseObject({}))
                        .optional()
                        .describe('URL spans in this block.'),
                    })
                    .optional()
                    .describe('Block-level metadata for mentions, hashtags, cashtags, and URLs.'),
                  entity_ranges: z
                    .array(
                      z.object({
                        key: z.number().int().min(0).describe('Index into the entities array.'),
                        length: z.number().int().min(0).describe('Length of the entity range.'),
                        offset: z.number().int().min(0).describe('Start offset in the text.'),
                      }),
                    )
                    .optional()
                    .describe('References to entries in entities.'),
                  inline_style_ranges: z
                    .array(
                      z.object({
                        length: z.number().int().min(0).describe('Length of the styled range.'),
                        offset: z.number().int().min(0).describe('Start offset in the text.'),
                        style: z
                          .enum(['bold', 'italic', 'strikethrough'])
                          .describe('The inline style.'),
                      }),
                    )
                    .optional()
                    .describe('Inline formatting ranges.'),
                  key: z.string().optional().describe('Optional block key.'),
                  text: z.string().describe('The text content of this block.'),
                  type: z
                    .enum([
                      'unstyled',
                      'header-one',
                      'header-two',
                      'header-three',
                      'unordered-list-item',
                      'ordered-list-item',
                      'blockquote',
                      'atomic',
                    ])
                    .describe(
                      'The block type. Use atomic for non-text embeds (image, post, markdown, divider, latex).',
                    ),
                }),
              )
              .describe('The text blocks that make up the article body.'),
            entities: z
              .array(
                z.object({
                  key: z.string().describe('The entity key referenced by entity_ranges.'),
                  value: z.object({
                    data: z.looseObject({}),
                    mutability: z
                      .enum(['immutable', 'mutable', 'segmented'])
                      .describe('Whether the entity can be edited.'),
                    type: z.enum([
                      'post',
                      'link',
                      'image',
                      'emoji',
                      'markdown',
                      'divider',
                      'latex',
                    ]),
                  }),
                }),
              )
              .describe(
                'Non-text entities referenced by blocks (links, embedded posts, images, emoji,          markdown/code/tables, dividers, LaTeX).',
              ),
          })
          .describe('DraftJS content state representing the article body.'),
        cover_media: z
          .object({
            media_category: z.string().describe('The media category (e.g.'),
            media_id: z.string().describe('The media ID from the media upload endpoint.'),
          })
          .optional()
          .describe('Optional cover media for the Article.'),
        title: z.string().describe('The title of the Article.'),
      },
    },
  ),
  op(
    'x_publish_article',
    'POST /2/articles/{article_id}/publish',
    'Publish a draft Article, making it public.',
    'tweet.write',
    { kind: 'service' },
  ),
  op(
    'x_get_posts',
    'GET /2/tweets',
    'Retrieves details of multiple Posts by their IDs.',
    'tweet.read users.read',
    {
      charge: 'post',
      query: { ids: z.array(z.string()) },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_post_analytics',
    'GET /2/tweets/analytics',
    'Retrieves analytics data for specified Posts within a defined time range.',
    'tweet.read users.read',
    {
      query: {
        ids: z.array(z.string()),
        start_time: z.string(),
        end_time: z.string(),
        granularity: z.enum(['hourly', 'weekly', 'daily', 'total']).optional(),
      },
      preset: {
        'analytics.fields':
          'app_install_attempts,app_opens,bookmarks,detail_expands,email_tweet,engagements,follows,hashtag_clicks,id,impressions,likes,media_views,permalink_clicks,quote_tweets,replies,retweets,shares,timestamp,timestamped_metrics,unfollows,unlikes,url_clicks,user_profile_clicks',
      },
    },
  ),
  op(
    'x_count_posts',
    'GET /2/tweets/counts/recent',
    'Count posts from the last 7 days that match a search query.',
    '',
    {
      query: {
        query: z.string(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        since_id: z.string().optional(),
        until_id: z.string().optional(),
        pagination_token: z.string().optional(),
        granularity: z.enum(['minute', 'hour', 'day']).optional(),
      },
      preset: { 'search_count.fields': '' },
    },
  ),
  op(
    'x_search_all_posts',
    'GET /2/tweets/search/all',
    'Search the full archive of posts.',
    'tweet.read users.read',
    {
      charge: 'post',
      query: {
        query: z.string(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        since_id: z.string().optional(),
        until_id: z.string().optional(),
        max_results: z.number().int().min(10).max(500).default(10),
        pagination_token: z.string().optional(),
        sort_order: z.enum(['recency', 'relevancy']).optional(),
      },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_search_posts',
    'GET /2/tweets/search/recent',
    'Search posts from the last 7 days.',
    'tweet.read users.read',
    {
      charge: 'post',
      query: {
        query: z.string(),
        max_results: z.number().int().min(10).max(100).default(10),
        pagination_token: z.string().optional(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        since_id: z.string().optional(),
        until_id: z.string().optional(),
        sort_order: z.enum(['recency', 'relevancy']).optional(),
      },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_delete_post',
    'DELETE /2/tweets/{id}',
    'Delete one of your own posts.',
    'tweet.read tweet.write users.read',
    { kind: 'service' },
  ),
  op(
    'x_get_post',
    'GET /2/tweets/{id}',
    'Retrieves details of a specific Post by its ID.',
    'tweet.read users.read',
    {
      charge: 'post',
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_post_likers',
    'GET /2/tweets/{id}/liking_users',
    'Retrieves a list of Users who liked a specific Post by its ID.',
    'like.read tweet.read users.read',
    {
      charge: 'user',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_post_quotes',
    'GET /2/tweets/{id}/quote_tweets',
    'Retrieves a list of Posts that quote a specific Post by its ID.',
    'tweet.read users.read',
    {
      charge: 'post',
      query: {
        max_results: z.number().int().min(10).max(100).default(10),
        pagination_token: z.string().optional(),
        exclude: z.array(z.enum(['replies', 'retweets'])).optional(),
      },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_post_reposters',
    'GET /2/tweets/{id}/retweeted_by',
    'Retrieves a list of Users who reposted a specific Post by its ID.',
    'tweet.read users.read',
    {
      charge: 'user',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_post_reposts',
    'GET /2/tweets/{id}/retweets',
    'Retrieves a list of Posts that repost a specific Post by its ID.',
    'tweet.read users.read',
    {
      charge: 'post',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_hide_reply',
    'PUT /2/tweets/{tweet_id}/hidden',
    'Hide or unhide a reply in a conversation you started.',
    'tweet.moderate.write tweet.read users.read',
    {
      kind: 'service',
      body: { hidden: z.boolean().describe('Whether the reply should be hidden.') },
    },
  ),
  op(
    'x_reposts_of_me',
    'GET /2/users/reposts_of_me',
    'Retrieves a list of Posts that repost content from the authenticated user.',
    'timeline.read tweet.read',
    {
      charge: 'post',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_bookmarks',
    'GET /2/users/{me}/bookmarks',
    'Read your bookmarks.',
    'bookmark.read tweet.read users.read',
    {
      charge: 'post',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_add_bookmark',
    'POST /2/users/{me}/bookmarks',
    'Bookmark one post, or up to 25 at once.',
    'bookmark.write tweet.read users.read',
    {
      kind: 'service',
      body: {
        folder_id: z
          .string()
          .optional()
          .describe('Optional ID of the Bookmark folder to add the Post(s) to.'),
        tweet_id: z
          .string()
          .optional()
          .describe("The ID of the Post to add to the user's Bookmarks."),
        tweet_ids: z
          .array(z.string())
          .optional()
          .describe("Post IDs to add to the user's Bookmarks."),
      },
    },
  ),
  op(
    'x_bookmark_folders',
    'GET /2/users/{me}/bookmarks/folders',
    'List your bookmark folders.',
    'bookmark.read users.read',
    {
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
    },
  ),
  op(
    'x_create_bookmark_folder',
    'POST /2/users/{me}/bookmarks/folders',
    'Create a bookmark folder.',
    'bookmark.write users.read',
    {
      kind: 'service',
      body: { name: z.string().describe('Name of the Bookmark folder (1-25 characters).') },
    },
  ),
  op(
    'x_bookmark_folder',
    'GET /2/users/{me}/bookmarks/folders/{folder_id}',
    'Read the posts in one of your bookmark folders.',
    'bookmark.read tweet.read users.read',
    {
      charge: 'post',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
    },
  ),
  op(
    'x_remove_bookmark',
    'DELETE /2/users/{me}/bookmarks/{tweet_id}',
    'Remove a post from your bookmarks.',
    'bookmark.write tweet.read users.read',
    { kind: 'service' },
  ),
  op(
    'x_liked_posts',
    'GET /2/users/{id}/liked_tweets',
    'Retrieves a list of Posts liked by a specific User by their ID.',
    'like.read tweet.read users.read',
    {
      charge: 'post',
      query: {
        max_results: z.number().int().min(5).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_like_post',
    'POST /2/users/{me}/likes',
    'Like a post.',
    'like.write tweet.read users.read',
    { kind: 'service', body: { tweet_id: z.string() } },
  ),
  op(
    'x_unlike_post',
    'DELETE /2/users/{me}/likes/{tweet_id}',
    'Remove your like from a post.',
    'like.write tweet.read users.read',
    { kind: 'service' },
  ),
  op(
    'x_mentions',
    'GET /2/users/{me}/mentions',
    'Read the posts that mention you.',
    'tweet.read users.read',
    {
      charge: 'post',
      query: {
        max_results: z.number().int().min(5).max(100).default(10),
        pagination_token: z.string().optional(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        since_id: z.string().optional(),
        until_id: z.string().optional(),
      },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_repost',
    'POST /2/users/{me}/retweets',
    'Repost a post.',
    'tweet.read tweet.write users.read',
    { kind: 'service', body: { tweet_id: z.string() } },
  ),
  op(
    'x_undo_repost',
    'DELETE /2/users/{me}/retweets/{source_tweet_id}',
    'Undo your repost of a post.',
    'tweet.read tweet.write users.read',
    { kind: 'service' },
  ),
  op(
    'x_home_timeline',
    'GET /2/users/{me}/timelines/reverse_chronological',
    'Read your home timeline, newest first.',
    'tweet.read users.read',
    {
      charge: 'post',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        since_id: z.string().optional(),
        until_id: z.string().optional(),
        exclude: z.array(z.enum(['replies', 'retweets'])).optional(),
      },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_user_posts',
    'GET /2/users/{id}/tweets',
    "Read another account's posts.",
    'tweet.read users.read',
    {
      charge: 'post',
      query: {
        max_results: z.number().int().min(5).max(100).default(10),
        pagination_token: z.string().optional(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        since_id: z.string().optional(),
        until_id: z.string().optional(),
        exclude: z.array(z.enum(['replies', 'retweets'])).optional(),
      },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op('x_my_posts', 'GET /2/users/{me}/tweets', 'Read your own posts.', 'tweet.read users.read', {
    charge: 'post',
    query: {
      max_results: z.number().int().min(5).max(100).default(10),
      pagination_token: z.string().optional(),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      since_id: z.string().optional(),
      until_id: z.string().optional(),
      exclude: z.array(z.enum(['replies', 'retweets'])).optional(),
    },
    preset: {
      'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
      expansions: 'author_id',
      'user.fields': 'username,name',
    },
  }),
];
