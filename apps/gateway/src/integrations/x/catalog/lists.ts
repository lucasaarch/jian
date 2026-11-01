import { z } from 'zod';
import { op, type XOperation } from './row.js';

export const listsOperations: XOperation[] = [
  op(
    'x_create_list',
    'POST /2/lists',
    'Creates a new List for the authenticated user.',
    'list.read list.write tweet.read users.read',
    {
      kind: 'service',
      body: {
        description: z
          .string()
          .optional()
          .describe('Description of the List (up to 100 characters).'),
        name: z.string().describe('Name of the List (1-25 characters).'),
        private: z.boolean().optional().describe('Whether the List is private.'),
      },
    },
  ),
  op(
    'x_delete_list',
    'DELETE /2/lists/{id}',
    'Deletes a specific List owned by the authenticated user by its ID.',
    'list.write tweet.read users.read',
    { kind: 'service' },
  ),
  op(
    'x_get_list',
    'GET /2/lists/{id}',
    'Retrieves details of a specific List by its ID.',
    'list.read tweet.read users.read',
    {
      charge: 'list',
      preset: {
        'list.fields': 'created_at,description,follower_count,id,member_count,name,private',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_update_list',
    'PUT /2/lists/{id}',
    'Updates the details of a specific List owned by the authenticated user by its ID.',
    'list.write tweet.read users.read',
    {
      kind: 'service',
      body: {
        description: z
          .string()
          .optional()
          .describe('New description for the List (up to 100 characters).'),
        name: z.string().optional().describe('New name for the List (1-25 characters).'),
        private: z.boolean().optional().describe('Whether the List is private.'),
      },
    },
  ),
  op(
    'x_list_followers',
    'GET /2/lists/{id}/followers',
    'Retrieves a list of Users who follow a specific List by its ID.',
    'list.read tweet.read users.read',
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
    'x_list_members',
    'GET /2/lists/{id}/members',
    'Retrieves a list of Users who are members of a specific List by its ID.',
    'list.read tweet.read users.read',
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
    'x_add_list_member',
    'POST /2/lists/{id}/members',
    'Adds a User to a specific List by its ID.',
    'list.write tweet.read users.read',
    { kind: 'service', body: { user_id: z.string() } },
  ),
  op(
    'x_remove_list_member',
    'DELETE /2/lists/{id}/members/{user_id}',
    'Removes a User from a List by their ID.',
    'list.write tweet.read users.read',
    { kind: 'service' },
  ),
  op(
    'x_list_posts',
    'GET /2/lists/{id}/tweets',
    'Retrieves a list of Posts associated with a specific List by its ID.',
    'list.read tweet.read users.read',
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
    'x_followed_lists',
    'GET /2/users/{id}/followed_lists',
    'Retrieves a list of Lists followed by a specific User by their ID.',
    'list.read tweet.read users.read',
    {
      charge: 'list',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: {
        'list.fields': 'created_at,description,follower_count,id,member_count,name,private',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_follow_list',
    'POST /2/users/{me}/followed_lists',
    'Follow a List.',
    'list.write tweet.read users.read',
    { kind: 'service', body: { list_id: z.string() } },
  ),
  op(
    'x_unfollow_list',
    'DELETE /2/users/{me}/followed_lists/{list_id}',
    'Unfollow a List.',
    'list.write tweet.read users.read',
    { kind: 'service' },
  ),
  op(
    'x_list_memberships',
    'GET /2/users/{id}/list_memberships',
    'Retrieves a list of Lists that a specific User is a member of by their ID.',
    'list.read tweet.read users.read',
    {
      charge: 'list',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: {
        'list.fields': 'created_at,description,follower_count,id,member_count,name,private',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_owned_lists',
    'GET /2/users/{id}/owned_lists',
    'Retrieves a list of Lists owned by a specific User by their ID.',
    'list.read tweet.read users.read',
    {
      charge: 'list',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: {
        'list.fields': 'created_at,description,follower_count,id,member_count,name,private',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_pinned_lists',
    'GET /2/users/{me}/pinned_lists',
    'Read the Lists you pinned.',
    'list.read tweet.read users.read',
    {
      charge: 'list',
      preset: {
        'list.fields': 'created_at,description,follower_count,id,member_count,name,private',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_pin_list',
    'POST /2/users/{me}/pinned_lists',
    'Pin a List.',
    'list.write tweet.read users.read',
    { kind: 'service', body: { list_id: z.string() } },
  ),
  op(
    'x_unpin_list',
    'DELETE /2/users/{me}/pinned_lists/{list_id}',
    'Unpin a List.',
    'list.write tweet.read users.read',
    { kind: 'service' },
  ),
];
