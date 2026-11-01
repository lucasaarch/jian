import { z } from 'zod';
import { op, type XOperation } from './row.js';

export const liveOperations: XOperation[] = [
  op(
    'x_broadcasts',
    'GET /2/broadcasts',
    "Returns the authenticated user's live-video broadcasts, or selected owned broadcasts when ids are provided.",
    'broadcast.read',
    {
      query: {
        ids: z
          .array(z.string())
          .optional()
          .describe('Comma-separated broadcast IDs to retrieve instead of listing broadcasts.'),
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: {
        'broadcast.fields':
          'available_for_replay,broadcast_id,chat_option,created_at_ms,end_ms,height,id,image_url,image_url_medium,image_url_small,is_high_latency,language,media_key,scheduled_end_ms,scheduled_start_ms,share_url,source_id,start_ms,state,title,total_watched,total_watching,tweet_id,twitter_user_id,updated_at_ms,width',
      },
    },
  ),
  op(
    'x_broadcast_moderators',
    'GET /2/broadcasts/chat/moderators',
    "Returns the authenticated broadcaster's persistent moderators as User resources.",
    'broadcast.read tweet.read users.read',
    { preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' } },
  ),
  op(
    'x_add_broadcast_moderator',
    'POST /2/broadcasts/chat/moderators',
    "Adds a moderator to the authenticated broadcaster's persistent list and returns the updated moderator user IDs.",
    'broadcast.read broadcast.write',
    {
      kind: 'service',
      body: { user_id: z.string().describe('The user to appoint as a moderator.') },
    },
  ),
  op(
    'x_remove_broadcast_moderator',
    'DELETE /2/broadcasts/chat/moderators/{user_id}',
    "Removes a moderator from the authenticated broadcaster's persistent list and returns the updated moderator user IDs.",
    'broadcast.read broadcast.write',
    { kind: 'service' },
  ),
  op(
    'x_broadcast_muted_users',
    'GET /2/broadcasts/chat/mutes',
    "Returns the users muted in the authenticated broadcaster's chat, with the expiry time of timed mutes.",
    'broadcast.read',
    {
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
      },
      preset: { 'broadcast_chat_mute.fields': 'end_at_ms', 'user.fields': 'username,name' },
    },
  ),
  op(
    'x_mute_in_broadcasts',
    'POST /2/broadcasts/chat/mutes',
    "Prevents a user from posting messages in all of a broadcaster's chats.",
    'broadcast.read broadcast.write',
    {
      kind: 'service',
      body: {
        broadcast_id: z
          .string()
          .optional()
          .describe("A broadcast whose host's chats the user is muted in."),
        end_at_ms: z
          .string()
          .optional()
          .describe('The Unix timestamp in milliseconds when the mute expires.'),
        message_id: z
          .string()
          .optional()
          .describe('A chat message in `broadcast_id` to remove while muting the user.'),
        user_id: z.string().describe('The user to mute.'),
      },
    },
  ),
  op(
    'x_unmute_in_broadcasts',
    'DELETE /2/broadcasts/chat/mutes/{user_id}',
    "Allows a muted user to post messages in a broadcaster's chats again.",
    'broadcast.read broadcast.write',
    {
      kind: 'service',
      query: {
        broadcast_id: z
          .string()
          .optional()
          .describe("A broadcast whose host's chats the user is unmuted in."),
      },
    },
  ),
  op(
    'x_scheduled_broadcasts',
    'GET /2/broadcasts/scheduled',
    'Returns scheduled broadcasts owned by the authenticated user.',
    'broadcast.read',
    {
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        oldest_start_time: z.string().optional(),
        newest_start_time: z.string().optional(),
        pagination_token: z.string().optional(),
      },
    },
  ),
  op(
    'x_schedule_broadcast',
    'POST /2/broadcasts/scheduled',
    'Schedules a broadcast for the authenticated user.',
    'broadcast.read broadcast.write',
    {
      kind: 'service',
      body: {
        available_for_replay: z.boolean().optional().describe('Enable replay.'),
        chat_option: z.string().optional(),
        description: z.string().optional().describe('Description.'),
        is_locked: z.boolean().optional().describe('Lock the broadcast.'),
        locale: z.string().optional().describe('Locale.'),
        manual_publish: z
          .boolean()
          .optional()
          .describe('If true, do not auto-publish at start; call POST .../live when ready.'),
        recurrence: z
          .object({
            frequency: z.enum(['Daily', 'Weekly']).describe('Recurrence frequency.'),
            repeats: z.string().describe('Number of repeats (numeric string).'),
          })
          .optional()
          .describe(
            'Deprecated: recurring schedules are being retired and requests that include `recurrence` will be rejected.',
          ),
        scheduled_end_ms: z
          .string()
          .optional()
          .describe('Optional end time, ms since Unix epoch (decimal string).'),
        scheduled_start_ms: z
          .string()
          .describe('Start time, ms since Unix epoch (decimal string).'),
        source_id: z
          .string()
          .describe('Ingest / source id to bind (same as sources `rtmp_stream_key`).'),
        telecast_id: z
          .string()
          .optional()
          .describe(
            'Deprecated: telecast associations are being retired and this field will be ignored.',
          ),
        thumbnail_media_id: z
          .string()
          .optional()
          .describe('Pre-live slate media id (numeric string).'),
        title: z.string().optional().describe('Title / status text.'),
      },
    },
  ),
  op(
    'x_delete_scheduled_broadcast',
    'DELETE /2/broadcasts/scheduled/{id}',
    'Deletes a scheduled broadcast by its alphanumeric broadcast id.',
    'broadcast.read broadcast.write',
    {
      kind: 'service',
      query: {
        roll_forward: z
          .boolean()
          .optional()
          .describe(
            'Deprecated: recurring schedules are being retired and `true` will be rejected.',
          ),
      },
    },
  ),
  op(
    'x_get_scheduled_broadcast',
    'GET /2/broadcasts/scheduled/{id}',
    'Returns a single scheduled broadcast by its alphanumeric broadcast id.',
    'broadcast.read',
  ),
  op(
    'x_update_scheduled_broadcast',
    'PUT /2/broadcasts/scheduled/{id}',
    'Updates a scheduled broadcast.',
    'broadcast.read broadcast.write',
    {
      kind: 'service',
      body: {
        available_for_replay: z.boolean().optional().describe('Enable replay.'),
        chat_option: z.string().optional(),
        description: z.string().optional().describe('Description.'),
        is_locked: z.boolean().optional().describe('Lock the broadcast.'),
        locale: z.string().optional().describe('Locale.'),
        manual_publish: z
          .boolean()
          .optional()
          .describe('If true, do not auto-publish at start; call POST .../live when ready.'),
        roll_forward: z
          .boolean()
          .optional()
          .describe(
            'Deprecated: recurring schedules are being retired and `true` will be rejected.',
          ),
        scheduled_broadcast_id: z.string().describe('Numeric scheduler id from create/list/get.'),
        scheduled_end_ms: z.string().describe('End time, ms since Unix epoch (decimal string).'),
        scheduled_start_ms: z
          .string()
          .describe('Start time, ms since Unix epoch (decimal string).'),
        source_id: z.string().optional().describe('Ingest / source id.'),
        thumbnail_media_id: z
          .string()
          .optional()
          .describe('Pre-live slate media id (numeric string).'),
        title: z.string().optional().describe('Title / status text.'),
      },
    },
  ),
  op(
    'x_go_live',
    'POST /2/broadcasts/scheduled/{id}/live',
    'Publishes a schedule that was created or updated with `manual_publish: true`.',
    'broadcast.read broadcast.write',
    { kind: 'service' },
  ),
  op(
    'x_delete_broadcast',
    'DELETE /2/broadcasts/{id}',
    "Deletes one of the authenticated user's broadcasts, scheduled or ended, including its replay.",
    'broadcast.read broadcast.write',
    { kind: 'service' },
  ),
  op(
    'x_get_broadcast',
    'GET /2/broadcasts/{id}',
    'Returns a broadcast owned by the authenticated user.',
    'broadcast.read',
    {
      preset: {
        'broadcast.fields':
          'available_for_replay,broadcast_id,chat_option,created_at_ms,end_ms,height,id,image_url,image_url_medium,image_url_small,is_high_latency,language,media_key,scheduled_end_ms,scheduled_start_ms,share_url,source_id,start_ms,state,title,total_watched,total_watching,tweet_id,twitter_user_id,updated_at_ms,width',
      },
    },
  ),
  op(
    'x_broadcast_chat',
    'GET /2/broadcasts/{id}/chat',
    'Returns newest-first chat messages for a broadcast owned by the authenticated user.',
    'broadcast.read',
    {
      query: {
        max_results: z.number().int().min(1).max(200).default(10),
        pagination_token: z.string().optional(),
      },
      preset: {
        'broadcast_chat_message.fields':
          'author_name,author_username,broadcast_id,created_at_ms,id,reply_to,text',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_send_broadcast_chat',
    'POST /2/broadcasts/{id}/chat',
    'Posts a chat message to a running broadcast, attributed to the authenticated user.',
    'broadcast.read broadcast.write',
    {
      kind: 'message',
      body: {
        reply_to: z
          .string()
          .optional()
          .describe('Message id to reply to, returned as timestamp when sent.'),
        text: z.string().describe('The chat message text.'),
      },
    },
  ),
  op(
    'x_mute_in_broadcast',
    'POST /2/broadcasts/{id}/chat/mutes',
    'Prevents a user from posting further messages in a running broadcast chat.',
    'broadcast.read broadcast.write',
    {
      kind: 'service',
      body: {
        end_at_ms: z
          .string()
          .optional()
          .describe('The Unix timestamp in milliseconds when the mute expires.'),
        message_id: z
          .string()
          .optional()
          .describe('A chat message to remove while muting the user.'),
        user_id: z.string().describe('The user to mute.'),
      },
    },
  ),
  op(
    'x_unmute_in_broadcast',
    'DELETE /2/broadcasts/{id}/chat/mutes/{user_id}',
    'Allows a muted user to post messages in a running broadcast chat again.',
    'broadcast.read broadcast.write',
    { kind: 'service' },
  ),
  op(
    'x_delete_broadcast_chat',
    'DELETE /2/broadcasts/{id}/chat/{message_id}',
    'Removes a specific chat message from a running broadcast where the authenticated user is the host or a moderator.',
    'broadcast.read broadcast.write',
    { kind: 'service' },
  ),
  op(
    'x_start_call',
    'POST /2/calls',
    'Starts an X call hosted by the authenticated user (typically a bot).',
    'calls.write',
    {
      kind: 'service',
      body: {
        audio_only: z.boolean().optional().describe('Start the call without video.'),
        conversation_id: z.string().optional().describe('XChat conversation to start the call in.'),
        join_policy: z
          .enum(['open', 'closed', 'trusted'])
          .optional()
          .describe(
            "open (default): anyone with the link joins; closed: the host admits each person; trusted: members of the host's Verified Organization join, others ask.",
          ),
        title: z.string().optional().describe('Title shown to participants.'),
      },
    },
  ),
  op(
    'x_scheduled_calls',
    'GET /2/calls/scheduled',
    "Returns the X calls on the authenticated user's calendar, earliest first: events on their X Calls calendar, and events on the Microsoft Outlook calendars they linked to X whose con",
    'calls.read',
    {
      query: {
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        max_results: z.number().int().min(1).max(100).default(10),
      },
      preset: {
        'scheduled_call.fields':
          'calendar,call_id,description,end_time,id,join_url,occurrence_start_time,recurrence,start_time,status,time_zone,title',
        'call.fields':
          'conversation_id,created_at,id,join_policy,join_url,participant_count,title,viewer_may_join',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_schedule_call',
    'POST /2/calls/scheduled',
    'Put a call on your X Calls calendar and invite people to it.',
    'calls.write',
    {
      kind: 'message',
      body: {
        description: z.string().optional().describe('What the call is about.'),
        duration_minutes: z
          .number()
          .int()
          .min(1)
          .max(44640)
          .optional()
          .describe('How long the call lasts, in minutes.'),
        invitee_ids: z.array(z.string()).optional().describe('X user ids of the people to invite.'),
        notify_invitees: z
          .boolean()
          .optional()
          .describe('Whether invitees get an email about the call.'),
        recurrence: z
          .string()
          .optional()
          .describe(
            'RFC 5545 RRULE to repeat the call by, such as FREQ=WEEKLY;BYDAY=MO; the RRULE: prefix is optional.',
          ),
        start_time: z.string(),
        time_zone: z
          .string()
          .optional()
          .describe('IANA time zone the recurrence follows, such as America/Los_Angeles.'),
        title: z.string().optional().describe('Title invitees see.'),
      },
    },
  ),
  op(
    'x_cancel_scheduled_call',
    'DELETE /2/calls/scheduled/{id}',
    "Cancels a scheduled call the authenticated user organizes, and takes it off invitees' calendars.",
    'calls.write',
    {
      kind: 'message',
      query: {
        scope: z
          .enum(['all', 'this', 'this_and_following'])
          .optional()
          .describe(
            'Which occurrences: all (the default without occurrence_start_time), this (the default with it), or this_and_following.',
          ),
        occurrence_start_time: z
          .string()
          .optional()
          .describe(
            'Start of the occurrence that scope this or this_and_following refers to (RFC 3339).',
          ),
        notify_invitees: z.boolean().optional().describe('Whether invitees get an email about it.'),
      },
    },
  ),
  op(
    'x_get_scheduled_call',
    'GET /2/calls/scheduled/{id}',
    'Returns a scheduled call the authenticated user organizes or is invited to, at its occurrence running now or its next one within a year: its time, call, recurrence and who is invit',
    'calls.read',
    {
      preset: {
        'scheduled_call.fields':
          'calendar,call_id,description,end_time,id,join_url,occurrence_start_time,recurrence,start_time,status,time_zone,title',
        'call.fields':
          'conversation_id,created_at,id,join_policy,join_url,participant_count,title,viewer_may_join',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_update_scheduled_call',
    'PUT /2/calls/scheduled/{id}',
    'Move, rename or re-invite a scheduled call you organize.',
    'calls.write',
    {
      kind: 'message',
      body: {
        description: z.string().optional().describe('What the call is about.'),
        duration_minutes: z
          .number()
          .int()
          .min(1)
          .max(44640)
          .optional()
          .describe('How long the call lasts, in minutes.'),
        invitee_ids: z
          .array(z.string())
          .optional()
          .describe('Everyone to invite: replaces the invite list.'),
        notify_invitees: z
          .boolean()
          .optional()
          .describe('Whether invitees get an email about the change.'),
        occurrence_start_time: z
          .string()
          .optional()
          .describe(
            'Start of the occurrence that scope this or this_and_following refers to (RFC 3339).',
          ),
        recurrence: z
          .string()
          .optional()
          .describe('RFC 5545 RRULE to repeat the call by, such as FREQ=WEEKLY;BYDAY=MO.'),
        scope: z
          .enum(['all', 'this', 'this_and_following'])
          .optional()
          .describe(
            'Which occurrences of a recurring call: all (the default without occurrence_start_time), this (the default with it), or this_and_following.',
          ),
        start_time: z.string().optional(),
        time_zone: z.string().optional().describe('IANA time zone the recurrence follows.'),
        title: z.string().optional().describe('Title invitees see.'),
      },
    },
  ),
  op(
    'x_answer_call_invite',
    'POST /2/calls/scheduled/{id}/rsvp',
    'Accepts, declines or tentatively accepts an invitation to a scheduled call for the authenticated user.',
    'calls.write',
    {
      kind: 'service',
      body: {
        occurrence_start_time: z
          .string()
          .optional()
          .describe(
            'Start of the occurrence that scope this or this_and_following refers to (RFC 3339).',
          ),
        response: z
          .enum(['accepted', 'declined', 'tentative'])
          .describe('The answer to the invitation.'),
        scope: z
          .enum(['all', 'this', 'this_and_following'])
          .optional()
          .describe(
            'Which occurrences of a recurring call: all (the default without occurrence_start_time), this (the default with it), or this_and_following.',
          ),
      },
    },
  ),
  op(
    'x_get_call',
    'GET /2/calls/{id}',
    "Returns a call's title, join policy, host and participant count, and whether the authenticated user may join it without asking the host.",
    'calls.read',
    {
      preset: {
        'call.fields':
          'conversation_id,created_at,id,join_policy,join_url,participant_count,title,viewer_may_join',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_ingest_region',
    'GET /2/region',
    'Returns the ingest region nearest the server handling the request.',
    'broadcast.read',
  ),
  op(
    'x_sources',
    'GET /2/sources',
    "Returns the authenticated user's RTMP/RTMPS stream sources.",
    'broadcast.read',
  ),
  op(
    'x_create_source',
    'POST /2/sources',
    'Creates a persistent RTMP/RTMPS ingest point for the authenticated user.',
    'broadcast.read broadcast.write',
    {
      kind: 'service',
      body: { name: z.string().describe('Label for the source.'), region: z.string() },
    },
  ),
  op(
    'x_delete_source',
    'DELETE /2/sources/{id}',
    "Deletes one of the authenticated user's stream sources.",
    'broadcast.read broadcast.write',
    { kind: 'service' },
  ),
  op(
    'x_get_source',
    'GET /2/sources/{id}',
    "Returns one of the authenticated user's stream sources.",
    'broadcast.read',
  ),
  op(
    'x_rename_source',
    'PUT /2/sources/{id}',
    "Renames one of the authenticated user's stream sources.",
    'broadcast.read broadcast.write',
    { kind: 'service', body: { name: z.string().describe('New label for the source.') } },
  ),
  op(
    'x_get_spaces',
    'GET /2/spaces',
    'Retrieves details of multiple Spaces by their IDs.',
    'space.read tweet.read users.read',
    {
      charge: 'space',
      query: { ids: z.array(z.string()) },
      preset: {
        'space.fields':
          'created_at,ended_at,id,is_ticketed,lang,participant_count,scheduled_start,started_at,state,subscriber_count,title,updated_at',
        'user.fields': 'username,name',
        'topic.fields': 'description,id,name',
      },
    },
  ),
  op(
    'x_spaces_by_creators',
    'GET /2/spaces/by/creator_ids',
    'Retrieves details of Spaces created by specified User IDs.',
    'space.read tweet.read users.read',
    {
      charge: 'space',
      query: { user_ids: z.array(z.string()) },
      preset: {
        'space.fields':
          'created_at,ended_at,id,is_ticketed,lang,participant_count,scheduled_start,started_at,state,subscriber_count,title,updated_at',
        'user.fields': 'username,name',
        'topic.fields': 'description,id,name',
      },
    },
  ),
  op(
    'x_search_spaces',
    'GET /2/spaces/search',
    'Retrieves a list of Spaces matching the specified search query.',
    'space.read tweet.read users.read',
    {
      charge: 'space',
      query: {
        query: z.string(),
        state: z.enum(['live', 'scheduled', 'all']).optional(),
        max_results: z.number().int().min(1).max(100).default(10),
      },
      preset: {
        'space.fields':
          'created_at,ended_at,id,is_ticketed,lang,participant_count,scheduled_start,started_at,state,subscriber_count,title,updated_at',
        'user.fields': 'username,name',
        'topic.fields': 'description,id,name',
      },
    },
  ),
  op(
    'x_get_space',
    'GET /2/spaces/{id}',
    'Retrieves details of a specific Space by its ID.',
    'space.read tweet.read users.read',
    {
      charge: 'space',
      preset: {
        'space.fields':
          'created_at,ended_at,id,is_ticketed,lang,participant_count,scheduled_start,started_at,state,subscriber_count,title,updated_at',
        'user.fields': 'username,name',
        'topic.fields': 'description,id,name',
      },
    },
  ),
  op(
    'x_space_buyers',
    'GET /2/spaces/{id}/buyers',
    'Retrieves a list of Users who purchased tickets to a specific Space by its ID.',
    'space.read tweet.read users.read',
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
    'x_space_posts',
    'GET /2/spaces/{id}/tweets',
    'Retrieves a list of Posts shared in a specific Space by its ID.',
    'space.read tweet.read users.read',
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
    'x_create_broadcast',
    'POST /2/users/{me}/broadcasts',
    'Create a broadcast on one of your sources.',
    'broadcast.read broadcast.write',
    {
      kind: 'service',
      body: {
        is_low_latency: z.string().optional().describe('Ignored.'),
        region: z.string().optional().describe('Ignored: the source sets the region.'),
        source_id: z.string().describe("The source's `rtmp_stream_key`."),
      },
    },
  ),
  op(
    'x_set_broadcast_state',
    'PUT /2/users/{me}/broadcasts/{broadcast_id}/state',
    'Publish or end one of your broadcasts.',
    'broadcast.read broadcast.write',
    {
      kind: 'service',
      body: {
        chat_option: z.string().optional(),
        locale: z.string().optional().describe('Broadcast language. `PUBLISH` only.'),
        should_not_tweet: z.string().optional().describe('Skip the announcing Post.'),
        state: z.string().describe('`PUBLISH` or `END`.'),
        title: z.string().optional().describe('Broadcast title. `PUBLISH` only.'),
      },
    },
  ),
];
