import { z } from 'zod';
import { op, type XOperation } from './row.js';

export const discoverOperations: XOperation[] = [
  op(
    'x_search_communities',
    'GET /2/communities/search',
    'Retrieves a list of Communities matching the specified search query.',
    'tweet.read users.read',
    {
      charge: 'community',
      query: {
        query: z.string(),
        max_results: z.number().int().min(10).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: {
        'community.fields': 'access,created_at,description,id,join_policy,member_count,name',
      },
    },
  ),
  op(
    'x_get_community',
    'GET /2/communities/{id}',
    'Retrieves details of a specific Community by its ID.',
    'list.read tweet.read users.read',
    {
      charge: 'community',
      preset: {
        'community.fields': 'access,created_at,description,id,join_policy,member_count,name',
      },
    },
  ),
  op(
    'x_search_news',
    'GET /2/news/search',
    'Retrieves a list of News stories matching the specified search query.',
    'tweet.read users.read',
    {
      query: {
        query: z.string(),
        max_results: z.number().int().min(1).max(100).default(10),
        max_age_hours: z.number().int().min(1).max(720).optional(),
      },
      preset: {
        'news.fields':
          'category,cluster_posts_results,contexts,contexts,contexts,contexts,disclaimer,hook,id,keywords,name,summary,updated_at',
      },
    },
  ),
  op('x_get_news', 'GET /2/news/{id}', 'Retrieves news story by its ID.', 'tweet.read users.read', {
    preset: {
      'news.fields':
        'category,cluster_posts_results,contexts,contexts,contexts,contexts,disclaimer,hook,id,keywords,name,summary,updated_at',
    },
  }),
  op('x_create_note', 'POST /2/notes', 'Creates a Community Note on a Post.', 'tweet.write', {
    kind: 'service',
    body: {
      info: z
        .object({
          classification: z
            .enum(['misinformed_or_potentially_misleading', 'not_misleading'])
            .describe('Community Note classification.'),
          is_media_note: z.boolean().optional().describe('Whether the note is a media note.'),
          misleading_tags: z
            .array(
              z.enum([
                'disputed_claim_as_fact',
                'factual_error',
                'manipulated_media',
                'misinterpreted_satire',
                'missing_important_context',
                'other',
                'outdated_information',
              ]),
            )
            .describe('Tags describing why the Post is misleading.'),
          text: z.string().describe('The text summary of the Community Note (must contain a URL).'),
          trustworthy_sources: z.boolean().describe('Whether the note cites trustworthy sources.'),
        })
        .describe('The Community Note contents.'),
      post_id: z.string().describe('ID of the Post the note is about.'),
      test_mode: z
        .boolean()
        .describe('If true, the note is only for testing and is not publicly visible.'),
    },
  }),
  op(
    'x_evaluate_note',
    'POST /2/notes/evaluate',
    'Evaluates the text of a proposed Community Note on a Post and returns its claim-opinion score.',
    'tweet.write',
    {
      body: {
        note_text: z.string().describe('Text of the community note to evaluate.'),
        post_id: z.string().describe('ID of the Post the note evaluates.'),
      },
    },
  ),
  op(
    'x_my_notes',
    'GET /2/notes/search/notes_written',
    'Retrieves the Community Notes written by the authenticated user.',
    'tweet.read',
    {
      charge: 'note',
      query: {
        test_mode: z.boolean(),
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: { 'note.fields': 'id,info,scoring_status,status,test_result' },
    },
  ),
  op(
    'x_note_eligible_posts',
    'GET /2/notes/search/posts_eligible_for_notes',
    'Retrieves Posts that are eligible for Community Notes.',
    'tweet.read',
    {
      charge: 'post',
      query: {
        test_mode: z.boolean(),
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
        post_selection: z.string().optional(),
      },
      preset: {
        'post.fields': 'created_at,conversation_id,public_metrics,lang,entities',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op('x_delete_note', 'DELETE /2/notes/{id}', 'Deletes a community note.', 'tweet.write', {
    kind: 'service',
  }),
  op(
    'x_trends',
    'GET /2/trends/by/woeid/{woeid}',
    'Retrieves trending topics for a specific location identified by its WOEID.',
    '',
    {
      query: { max_trends: z.number().int().min(1).max(50).optional() },
      preset: { 'trend.fields': 'trend_name,tweet_count' },
    },
  ),
  op(
    'x_my_trends',
    'GET /2/users/personalized_trends',
    'Retrieves personalized trending topics for the authenticated user.',
    'tweet.read users.read',
    { preset: { 'personalized_trend.fields': 'category,post_count,trend_name,trending_since' } },
  ),
];
