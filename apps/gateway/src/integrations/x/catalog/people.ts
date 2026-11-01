import { z } from 'zod';
import { op, type XOperation } from './row.js';

export const peopleOperations: XOperation[] = [
  op(
    'x_get_users',
    'GET /2/users',
    'Retrieves details of multiple Users by their IDs.',
    'tweet.read users.read',
    {
      charge: 'user',
      query: { ids: z.array(z.string()) },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_get_users_by_handle',
    'GET /2/users/by',
    'Retrieves details of multiple Users by their usernames.',
    'tweet.read users.read',
    {
      charge: 'user',
      query: { usernames: z.array(z.string()) },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_get_user_by_handle',
    'GET /2/users/by/username/{username}',
    'Retrieves details of a specific User by their username.',
    'tweet.read users.read',
    {
      charge: 'user',
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op('x_me', 'GET /2/users/me', 'Read your own profile.', 'tweet.read users.read', {
    preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
  }),
  op(
    'x_my_followers',
    'GET /2/users/me/followers',
    'Read who follows you.',
    'follows.read tweet.read users.read',
    {
      charge: 'user',
      query: {
        max_results: z.number().int().min(1).max(1000).default(10),
        pagination_token: z.string().optional(),
      },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_my_following',
    'GET /2/users/me/following',
    'Read who you follow.',
    'follows.read tweet.read users.read',
    {
      charge: 'user',
      query: {
        max_results: z.number().int().min(1).max(1000).default(10),
        pagination_token: z.string().optional(),
      },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_search_users',
    'GET /2/users/search',
    'Retrieves a list of Users matching a search query.',
    'tweet.read users.read',
    {
      charge: 'user',
      query: {
        query: z.string(),
        max_results: z.number().int().min(1).max(1000).default(10),
        next_token: z.string().optional(),
      },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_get_user',
    'GET /2/users/{id}',
    'Retrieves details of a specific User by their ID.',
    'tweet.read users.read',
    {
      charge: 'user',
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_user_affiliates',
    'GET /2/users/{id}/affiliates',
    'Retrieves a list of Users who are affiliated with a specific organization User by their ID.',
    'tweet.read users.read',
    {
      charge: 'user',
      query: {
        max_results: z.number().int().min(1).max(1000).default(10),
        pagination_token: z.string().optional(),
      },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_blocked_users',
    'GET /2/users/{me}/blocking',
    'Read who you block.',
    'block.read tweet.read users.read',
    {
      charge: 'user',
      query: {
        max_results: z.number().int().min(1).max(1000).default(10),
        pagination_token: z.string().optional(),
      },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_block',
    'POST /2/users/{me}/blocking',
    'Block an account.',
    'block.write tweet.read users.read',
    { kind: 'service', body: { target_user_id: z.string() } },
  ),
  op(
    'x_block_dms',
    'POST /2/users/{id}/dm/block',
    'Block direct messages to and from an account.',
    'dm.write tweet.read users.read',
    { kind: 'service' },
  ),
  op(
    'x_unblock_dms',
    'POST /2/users/{id}/dm/unblock',
    'Unblock direct messages to and from an account.',
    'dm.write tweet.read users.read',
    { kind: 'service' },
  ),
  op(
    'x_user_followers',
    'GET /2/users/{id}/followers',
    'Retrieves a list of Users who follow a specific User by their ID.',
    'follows.read tweet.read users.read',
    {
      charge: 'user',
      query: {
        max_results: z.number().int().min(1).max(1000).default(10),
        pagination_token: z.string().optional(),
      },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_user_following',
    'GET /2/users/{id}/following',
    'Retrieves a list of Users followed by a specific User by their ID.',
    'follows.read tweet.read users.read',
    {
      charge: 'user',
      query: {
        max_results: z.number().int().min(1).max(1000).default(10),
        pagination_token: z.string().optional(),
      },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_follow',
    'POST /2/users/{me}/following',
    'Follow an account.',
    'follows.write tweet.read users.read',
    { kind: 'service', body: { target_user_id: z.string() } },
  ),
  op(
    'x_muted_users',
    'GET /2/users/{me}/muting',
    'Read who you mute.',
    'mute.read tweet.read users.read',
    {
      charge: 'user',
      query: {
        max_results: z.number().int().min(1).max(1000).default(10),
        pagination_token: z.string().optional(),
      },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_mute',
    'POST /2/users/{me}/muting',
    'Mute an account.',
    'mute.write tweet.read users.read',
    { kind: 'service', body: { target_user_id: z.string() } },
  ),
  op(
    'x_unblock',
    'DELETE /2/users/{me}/blocking/{target_user_id}',
    'Unblock an account.',
    'block.write tweet.read users.read',
    { kind: 'service' },
  ),
  op(
    'x_unfollow',
    'DELETE /2/users/{me}/following/{target_user_id}',
    'Unfollow an account.',
    'follows.write tweet.read users.read',
    { kind: 'service' },
  ),
  op(
    'x_unmute',
    'DELETE /2/users/{me}/muting/{target_user_id}',
    'Unmute an account.',
    'mute.write tweet.read users.read',
    { kind: 'service' },
  ),
];
