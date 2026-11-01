import { z } from 'zod';
import { op, type XOperation } from './row.js';

export const messagesOperations: XOperation[] = [
  op(
    'x_chat_conversations',
    'GET /2/chat/conversations',
    'List your Chat conversations, newest first. Their message contents are end-to-end encrypted and not readable here.',
    'dm.read users.read',
    {
      query: {
        max_results: z.number().int().min(1).max(1000).default(10),
        pagination_token: z.string().optional(),
        unread_only: z.boolean().optional().describe('Return only unread conversations.'),
        type: z
          .enum(['direct', 'group'])
          .optional()
          .describe('Only direct (1:1) or only group conversations.'),
        is_archived: z
          .boolean()
          .optional()
          .describe('true: only archived; false: only not archived.'),
        is_muted: z.boolean().optional().describe('true: only muted; false: only not muted.'),
        participant_ids: z
          .array(z.string())
          .optional()
          .describe('Comma-separated numeric user IDs (1-10), all in the chat.'),
        participant_query: z
          .string()
          .optional()
          .describe(
            'Name or @username prefix (1-50 chars); keeps chats where any other participant matches it.',
          ),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
      },
      preset: {
        'chat_conversation.fields':
          'admin_settings,created_at,group_avatar_url,group_description,group_description_key_version,group_name,id,invite,is_archived,is_muted,last_read_event_id,message_ttl_ms,newest_event_id,pending_member_ids,screen_capture_blocking_enabled,screen_capture_detection_enabled,type,unread,updated_at',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_chat_delete_conversation',
    'DELETE /2/chat/conversations/{id}',
    'Deletes a Chat conversation for the authenticated user only; other participants keep it.',
    'dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_chat_conversation',
    'GET /2/chat/conversations/{id}',
    'Returns metadata for a Chat conversation including type, muted status, group details, and your unread state.',
    'dm.read tweet.read users.read',
    {
      preset: {
        'chat_conversation.fields':
          'admin_settings,created_at,group_avatar_url,group_description,group_description_key_version,group_name,id,invite,is_archived,is_muted,last_read_event_id,message_ttl_ms,newest_event_id,pending_member_ids,screen_capture_blocking_enabled,screen_capture_detection_enabled,type,unread,updated_at',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_chat_admin_requests',
    'GET /2/chat/conversations/{id}/admin_requests',
    'Returns the users who have asked to become admins of an encrypted Chat group conversation.',
    'dm.read tweet.read users.read',
    {
      query: { pagination_token: z.string().optional() },
      preset: { 'post.fields': 'created_at,conversation_id,public_metrics,lang,entities' },
    },
  ),
  op(
    'x_chat_request_admin',
    'POST /2/chat/conversations/{id}/admin_requests',
    'Asks the admins of an encrypted Chat group conversation to make the authenticated user an admin.',
    'dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_chat_approve_admin',
    'POST /2/chat/conversations/{id}/admin_requests/{user_id}/approve',
    'Makes the user who requested admin permissions an admin of an encrypted Chat group conversation.',
    'dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_chat_reject_admin',
    'POST /2/chat/conversations/{id}/admin_requests/{user_id}/reject',
    "Declines a user's pending request for admin permissions in an encrypted Chat group conversation.",
    'dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_chat_admin_settings',
    'PUT /2/chat/conversations/{id}/admin_settings',
    'Set which actions only admins can perform in a Chat group.',
    'dm.write tweet.read users.read',
    {
      kind: 'service',
      body: {
        add_member: z.boolean().optional().describe('When true, only admins can add members.'),
        block_screen_capture: z
          .boolean()
          .optional()
          .describe('When true, only admins can change screen capture blocking.'),
        edit_group_info: z
          .boolean()
          .optional()
          .describe('When true, only admins can edit the group name, avatar, and description.'),
        edit_message_ttl: z
          .boolean()
          .optional()
          .describe('When true, only admins can change the disappearing-message timer.'),
        send_message: z.boolean().optional().describe('When true, only admins can send messages.'),
        start_call: z.boolean().optional().describe('When true, only admins can start calls.'),
      },
    },
  ),
  op(
    'x_chat_add_admins',
    'POST /2/chat/conversations/{id}/admins',
    'Grants admin rights to one or more members of an existing encrypted Chat group conversation.',
    'dm.write tweet.read users.read',
    {
      kind: 'service',
      body: { user_ids: z.array(z.string()).describe('List of member user IDs to make admins.') },
    },
  ),
  op(
    'x_chat_remove_admins',
    'POST /2/chat/conversations/{id}/admins/remove',
    'Revokes admin rights from one or more admins of an existing encrypted Chat group conversation.',
    'dm.write tweet.read users.read',
    {
      kind: 'service',
      body: {
        user_ids: z
          .array(z.string())
          .describe('List of admin user IDs to revoke admin rights from.'),
      },
    },
  ),
  op(
    'x_chat_unarchive',
    'DELETE /2/chat/conversations/{id}/archive',
    'Unarchive a Chat conversation for you only.',
    'dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_chat_archive',
    'POST /2/chat/conversations/{id}/archive',
    'Archive a Chat conversation for you only.',
    'dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_chat_disable_invite',
    'DELETE /2/chat/conversations/{id}/invite',
    'Turns off the invite link for an encrypted Chat group conversation.',
    'dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_chat_enable_invite',
    'POST /2/chat/conversations/{id}/invite',
    'Turns on the invite link for an encrypted Chat group conversation and returns the link details.',
    'dm.write tweet.read users.read',
    {
      kind: 'service',
      body: {
        affiliate_user_id: z
          .string()
          .optional()
          .describe('ID of the affiliate account to associate with the link.'),
        decrypted_avatar_url: z
          .string()
          .optional()
          .describe('Group avatar URL (https) to show on the invite preview.'),
        decrypted_title: z
          .string()
          .optional()
          .describe('Group name to show on the invite preview.'),
        invite_url: z.string().optional(),
        validity_duration_msec: z
          .string()
          .optional()
          .describe(
            'How long the link stays valid, in milliseconds, from the time of the request.',
          ),
        validity_expiry_timestamp_msec: z
          .string()
          .optional()
          .describe('When the link expires, in epoch milliseconds.'),
        welcome_message: z
          .string()
          .optional()
          .describe('Message shown to people who open the link.'),
      },
    },
  ),
  op(
    'x_chat_invite',
    'GET /2/chat/conversations/{id}/invites/{token}',
    "Returns the preview of an encrypted Chat group conversation from its invite link: group name, avatar, member count, and the authenticated user's join state.",
    'dm.read tweet.read users.read',
    {
      preset: {
        'chat_group_invite.fields':
          'conversation_id,expires_at,group_avatar_url,group_name,invite_url,join_state,member_count,token,welcome_message',
      },
    },
  ),
  op(
    'x_chat_request_join',
    'POST /2/chat/conversations/{id}/join_requests',
    'Asks to join an encrypted Chat group conversation through its invite link.',
    'dm.write tweet.read users.read',
    {
      kind: 'service',
      body: {
        token: z.string().describe("The 10-character invite token from the group's invite link."),
      },
    },
  ),
  op(
    'x_chat_reject_joins',
    'POST /2/chat/conversations/{id}/join_requests/reject',
    'Rejects pending requests to join an encrypted Chat group conversation.',
    'dm.write tweet.read users.read',
    {
      kind: 'service',
      body: {
        user_ids: z.array(z.string()).describe('List of user IDs whose join requests to reject.'),
      },
    },
  ),
  op(
    'x_chat_clear_message_ttl',
    'DELETE /2/chat/conversations/{id}/message_ttl',
    'Stop new messages disappearing in a Chat conversation, for everyone in it.',
    'dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_chat_set_message_ttl',
    'PUT /2/chat/conversations/{id}/message_ttl',
    'Set how long new messages last in a Chat conversation, for everyone in it.',
    'dm.write tweet.read users.read',
    {
      kind: 'service',
      body: { message_ttl_ms: z.string().describe('How long new messages last, in milliseconds.') },
    },
  ),
  op(
    'x_chat_unmute',
    'DELETE /2/chat/conversations/{id}/mute',
    'Unmute notifications of a Chat conversation for you only.',
    'dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_chat_mute',
    'POST /2/chat/conversations/{id}/mute',
    'Mute notifications of a Chat conversation for you only.',
    'dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_chat_mark_read',
    'POST /2/chat/conversations/{id}/read',
    'Mark a Chat conversation read.',
    'dm.write tweet.read users.read',
    { kind: 'service', body: {} },
  ),
  op(
    'x_chat_set_screen_capture',
    'PUT /2/chat/conversations/{id}/screen_capture',
    'Turn screenshot blocking or detection on or off in a Chat conversation, for everyone in it.',
    'dm.write tweet.read users.read',
    {
      kind: 'service',
      body: {
        blocking: z
          .boolean()
          .optional()
          .describe('Whether participants are prevented from taking screenshots.'),
        blocking_action_signatures: z
          .array(
            z.object({
              encoded_message_event_detail: z
                .string()
                .describe('Base64-encoded Thrift MessageEventDetail for the signed action.'),
              message_event_signature: z
                .object({
                  message_signing_key_info_list: z
                    .array(
                      z.object({
                        member_id: z
                          .string()
                          .optional()
                          .describe('The member ID associated with this signing key.'),
                        public_key_version: z
                          .string()
                          .optional()
                          .describe('The version of the public key.'),
                        signing_public_key: z
                          .string()
                          .optional()
                          .describe('The signing public key.'),
                      }),
                    )
                    .optional()
                    .describe('List of signing key information for message verification.'),
                  public_key_version: z
                    .string()
                    .describe('The version of the public key used for signing.'),
                  signature: z.string().describe('The signature of the message event.'),
                  signature_version: z.string().describe('The version of the signature algorithm.'),
                  signing_public_key: z
                    .string()
                    .optional()
                    .describe('The public key used for signing.'),
                })
                .describe('Message event signature supplied with an action signature.'),
              message_id: z.string().describe('Client-generated ID of the message being signed.'),
              signature_payload: z
                .string()
                .optional()
                .describe(
                  'Payload string the client signed; used only in server-side failure logs.',
                ),
            }),
          )
          .optional()
          .describe(
            'Signatures for the screenshot blocking change, forwarded in the order they are sent.',
          ),
        detection: z
          .boolean()
          .optional()
          .describe('Whether participants are notified when someone takes a screenshot.'),
        detection_action_signatures: z
          .array(
            z.object({
              encoded_message_event_detail: z
                .string()
                .describe('Base64-encoded Thrift MessageEventDetail for the signed action.'),
              message_event_signature: z
                .object({
                  message_signing_key_info_list: z
                    .array(
                      z.object({
                        member_id: z
                          .string()
                          .optional()
                          .describe('The member ID associated with this signing key.'),
                        public_key_version: z
                          .string()
                          .optional()
                          .describe('The version of the public key.'),
                        signing_public_key: z
                          .string()
                          .optional()
                          .describe('The signing public key.'),
                      }),
                    )
                    .optional()
                    .describe('List of signing key information for message verification.'),
                  public_key_version: z
                    .string()
                    .describe('The version of the public key used for signing.'),
                  signature: z.string().describe('The signature of the message event.'),
                  signature_version: z.string().describe('The version of the signature algorithm.'),
                  signing_public_key: z
                    .string()
                    .optional()
                    .describe('The public key used for signing.'),
                })
                .describe('Message event signature supplied with an action signature.'),
              message_id: z.string().describe('Client-generated ID of the message being signed.'),
              signature_payload: z
                .string()
                .optional()
                .describe(
                  'Payload string the client signed; used only in server-side failure logs.',
                ),
            }),
          )
          .optional()
          .describe(
            'Signatures for the screenshot detection change, forwarded in the order they are sent.',
          ),
      },
    },
  ),
  op(
    'x_chat_typing',
    'POST /2/chat/conversations/{id}/typing',
    'Show the other people in a Chat conversation that you are typing.',
    'dm.write tweet.read users.read',
    { kind: 'message' },
  ),
  op(
    'x_chat_mark_unread',
    'POST /2/chat/conversations/{id}/unread',
    'Mark a Chat conversation unread.',
    'dm.write tweet.read users.read',
    { kind: 'service' },
  ),
  op(
    'x_chat_message_requests',
    'GET /2/chat/message_requests',
    "Retrieves the authenticated user's pending Chat message requests from one inbox.",
    'dm.read tweet.read users.read',
    {
      query: {
        inbox_type: z
          .enum(['you_may_know', 'low_quality'])
          .optional()
          .describe(
            "Which message request inbox to list: `you_may_know` (the apps' Priority tab) or `low_quality` (the apps' Hidden tab).",
          ),
        max_results: z.number().int().min(1).max(50).default(10),
        pagination_token: z.string().optional(),
      },
      preset: {
        'chat_message_request.fields':
          'conversation_id,conversation_key_events,encoded_message_create_event,has_more_events,message_events,sender_id,sender_recently_modified_profile,social_proof_user_ids',
      },
    },
  ),
  op(
    'x_chat_message_request',
    'GET /2/chat/message_requests/{id}',
    'Retrieves the message request state of a 1:1 Chat conversation and its newest message events.',
    'dm.read tweet.read users.read',
    {
      preset: {
        'chat_message_request_detail.fields':
          'conversation_id,conversation_key_events,has_more_events,message_events,message_request_state,participant_id',
      },
    },
  ),
  op(
    'x_chat_accept_request',
    'POST /2/chat/message_requests/{id}/accept',
    "Accepts the other user's pending message request in a 1:1 Chat conversation, which moves to the authenticated user's inbox.",
    'dm.write tweet.read users.read',
    { kind: 'service' },
  ),
  op(
    'x_chat_settings',
    'GET /2/chat/settings',
    "Returns the authenticated user's Chat privacy settings: who can message them, read receipts, the message quality filter, and audio/video call permissions.",
    'dm.read tweet.read users.read',
    {
      preset: {
        'chat_settings.fields':
          'allow_dms_from,always_allow_dms_from_subscribers,av_settings,dm_quality_filter,dm_receipt_settings',
      },
    },
  ),
  op(
    'x_chat_update_settings',
    'PUT /2/chat/settings',
    "Updates the authenticated user's Chat privacy settings: who can message them, read receipts, the message quality filter, and audio/video call permissions.",
    'dm.write tweet.read users.read',
    {
      kind: 'service',
      body: {
        allow_dms_from: z
          .enum(['all', 'verified', 'following'])
          .optional()
          .describe(
            'Who can send the user messages: `all` (anyone), `verified` (verified accounts only), or `following` (accounts the user follows).',
          ),
        always_allow_dms_from_subscribers: z
          .boolean()
          .optional()
          .describe(
            "Whether the user's subscribers can always message them regardless of allow_dms_from.",
          ),
        av_settings: z
          .object({
            av_call_permissions: z
              .object({
                accept_calls_from_addressbook: z
                  .boolean()
                  .optional()
                  .describe('Whether the user accepts calls from address-book contacts.'),
                accept_calls_from_everyone: z
                  .boolean()
                  .optional()
                  .describe('Whether the user accepts calls from anyone.'),
                accept_calls_from_following: z
                  .boolean()
                  .optional()
                  .describe('Whether the user accepts calls from accounts they follow.'),
                accept_calls_from_verified: z
                  .boolean()
                  .optional()
                  .describe('Whether the user accepts calls from verified accounts.'),
              })
              .optional()
              .describe('Who may place audio or video calls to the user.'),
            has_av_calls_enabled: z
              .boolean()
              .optional()
              .describe('Whether audio and video calls are enabled.'),
            has_enhanced_call_privacy_enabled: z
              .boolean()
              .optional()
              .describe('Whether enhanced call privacy is enabled.'),
          })
          .optional()
          .describe('Audio and video call settings.'),
        dm_quality_filter: z
          .enum(['enabled', 'disabled'])
          .optional()
          .describe(
            'Low-quality message request filter: `enabled` (low-quality requests go to a separate folder) or `disabled` (all requests stay in the main inbox).',
          ),
        dm_receipt_settings: z
          .enum(['all_enabled', 'all_disabled'])
          .optional()
          .describe(
            'Read receipts: `all_enabled` (send and receive read receipts) or `all_disabled` (neither).',
          ),
      },
    },
  ),
  op(
    'x_start_dm_group',
    'POST /2/dm_conversations',
    'Start a group direct message conversation, with a first message.',
    'dm.write tweet.read users.read',
    {
      kind: 'message',
      body: {
        conversation_type: z.enum(['Group']).describe('The conversation type to create.'),
        message: z
          .object({
            attachments: z
              .array(
                z.object({ media_id: z.string().describe('A media id to attach to the message.') }),
              )
              .optional()
              .describe('Attachments to include with the message.'),
            text: z.string().optional().describe('Text of the Direct Message.'),
          })
          .describe('The initial Direct Message to send to the conversation.'),
        participant_ids: z.array(z.string()).describe('Participants for the conversation.'),
      },
    },
  ),
  op(
    'x_dm_events_with',
    'GET /2/dm_conversations/with/{participant_id}/dm_events',
    'Retrieves direct message events for the one-to-one conversation between the authenticated user and a specific participant.',
    'dm.read tweet.read users.read',
    {
      charge: 'dm',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
        event_types: z
          .array(z.enum(['MessageCreate', 'ParticipantsJoin', 'ParticipantsLeave']))
          .optional(),
      },
      preset: {
        'dm_event.fields': 'id,text,created_at,event_type,dm_conversation_id,attachments',
        expansions: 'sender_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_send_dm',
    'POST /2/dm_conversations/with/{participant_id}/messages',
    'Send a direct message to one person.',
    'dm.write tweet.read users.read',
    {
      kind: 'message',
      body: {
        attachments: z
          .array(
            z.object({ media_id: z.string().describe('A media id to attach to the message.') }),
          )
          .optional()
          .describe('Attachments to include with the message.'),
        text: z.string().optional().describe('Text of the Direct Message.'),
      },
    },
  ),
  op(
    'x_send_dm_to_conversation',
    'POST /2/dm_conversations/{dm_conversation_id}/messages',
    'Send a direct message into a conversation.',
    'dm.write tweet.read users.read',
    {
      kind: 'message',
      body: {
        attachments: z
          .array(
            z.object({ media_id: z.string().describe('A media id to attach to the message.') }),
          )
          .optional()
          .describe('Attachments to include with the message.'),
        text: z.string().optional().describe('Text of the Direct Message.'),
      },
    },
  ),
  op(
    'x_dm_conversation_events',
    'GET /2/dm_conversations/{id}/dm_events',
    'Retrieves direct message events for a specific conversation by its ID.',
    'dm.read tweet.read users.read',
    {
      charge: 'dm',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
        event_types: z
          .array(z.enum(['MessageCreate', 'ParticipantsJoin', 'ParticipantsLeave']))
          .optional(),
      },
      preset: {
        'dm_event.fields': 'id,text,created_at,event_type,dm_conversation_id,attachments',
        expansions: 'sender_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_dm_events',
    'GET /2/dm_events',
    'Retrieves a list of recent direct message events across all conversations.',
    'dm.read tweet.read users.read',
    {
      charge: 'dm',
      query: {
        max_results: z.number().int().min(1).max(100).default(10),
        pagination_token: z.string().optional(),
        event_types: z
          .array(z.enum(['MessageCreate', 'ParticipantsJoin', 'ParticipantsLeave']))
          .optional(),
      },
      preset: {
        'dm_event.fields': 'id,text,created_at,event_type,dm_conversation_id,attachments',
        expansions: 'sender_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_delete_dm_event',
    'DELETE /2/dm_events/{event_id}',
    'Delete one of your direct messages.',
    'dm.read dm.write',
    { kind: 'service' },
  ),
  op(
    'x_get_dm_event',
    'GET /2/dm_events/{event_id}',
    'Retrieves details of a specific direct message event by its ID.',
    'dm.read tweet.read users.read',
    {
      charge: 'dm',
      preset: {
        'dm_event.fields': 'id,text,created_at,event_type,dm_conversation_id,attachments',
        expansions: 'sender_id',
        'user.fields': 'username,name',
      },
    },
  ),
  op(
    'x_chat_public_keys',
    'GET /2/users/public_keys',
    'Returns registered public keys for X Chat encryption for the specified users.',
    'dm.read tweet.read users.read',
    {
      query: { ids: z.array(z.string()) },
      preset: {
        'public_key.fields':
          'identity_public_key_signature,juicebox_config,public_key,public_key_version,signing_public_key',
      },
    },
  ),
  op(
    'x_chat_public_key',
    'GET /2/users/{id}/public_keys',
    "Returns a user's registered public keys for X Chat encryption.",
    'dm.read tweet.read users.read',
    {
      preset: {
        'public_key.fields':
          'identity_public_key_signature,juicebox_config,public_key,public_key_version,signing_public_key',
      },
    },
  ),
];
