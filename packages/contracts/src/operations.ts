import { z } from 'zod';
import {
  channelConnectionSchema,
  channelInputSchema,
  channelPatchSchema,
  channelQrSchema,
  channelSchema,
  contactPatchSchema,
  contactSchema,
  deliverySchema,
  groupSchema,
  ingressResultSchema,
  ingressSchema,
  telegramUpdateSchema,
} from './channels.js';
import {
  artifactPageSchema,
  artifactQuerySchema,
  leaseInputSchema,
  leaseSchema,
  mailInputSchema,
  mailSchema,
  pageQuerySchema,
} from './coordination.js';
import {
  decisionsInputSchema,
  decisionsSettingsPatchSchema,
  decisionsStatusSchema,
} from './decisions.js';
import {
  deviceFocusInputSchema,
  devicePairedSchema,
  devicePairInputSchema,
  devicePairingSchema,
  devicePatchSchema,
  devicePushInputSchema,
  deviceSchema,
} from './devices.js';
import {
  githubFixConflictsInputSchema,
  githubIssueSchema,
  githubItemParamsSchema,
  githubLinkSummarySchema,
  githubLinksInputSchema,
  githubMarkReadyInputSchema,
  githubMarkReadyResultSchema,
  githubMergeInputSchema,
  githubMergeResultSchema,
  githubPullFileLinesSchema,
  githubPullFileQuerySchema,
  githubPullSchema,
  githubUpdateBranchInputSchema,
  githubUpdateBranchResultSchema,
  sessionPullSchema,
} from './github-items.js';
import {
  githubConnectedRepositorySchema,
  githubInstallInputSchema,
  githubInstallSchema,
  githubIntegrationStatusSchema,
  githubManifestSchema,
  xAppInputSchema,
  xConnectSchema,
  xIntegrationStatusSchema,
} from './integrations.js';
import { inlineMediaSchema, mediaContentSchema, mediaRecordSchema } from './media.js';
import { messageReactionInputSchema } from './message-actions.js';
import {
  chatCompletionRequestSchema,
  chatCompletionSchema,
  openAiErrorSchema,
  openAiModelListSchema,
} from './openai.js';
import {
  builtinSkillSchema,
  gatewaySessionInputSchema,
  gatewaySessionTargetSchema,
  mcpDraftCheckSchema,
  mcpServerListInputSchema,
  mcpServerListSchema,
  mcpStatusSchema,
  memoryEditSchema,
  memoryKeySchema,
  profilePatchSchema,
  profileSchema,
  sessionModelSchema,
  sessionObjectiveInputSchema,
  sessionPinSchema,
  sessionProtectionSchema,
  sessionRenameSchema,
  sessionSchema,
  submitSchema,
} from './profile.js';
import { projectInputSchema, projectSchema } from './projects.js';
import {
  codexLoginSchema,
  modelDefaultsInputSchema,
  modelDefaultsRecordSchema,
  providerInputSchema,
  providerModelListSchema,
  providerRecordSchema,
} from './providers.js';
import { pushEndpointSchema, pushKeySchema, pushSubscriptionInputSchema } from './push.js';
import {
  activityDaySchema,
  activityQuerySchema,
  checkpointSchema,
  continuationSchema,
  eventSchema,
  memoryRecordSchema,
  messageRecordSchema,
  personSchema,
  profileRecordSchema,
  profileStatsSchema,
  revisionRecordSchema,
  runAnswerSchema,
  runApprovalInputSchema,
  runRecordSchema,
  runTimelineSchema,
  sessionChangesQuerySchema,
  sessionChangesSchema,
  sessionContextSchema,
  sessionRecordSchema,
  sessionSummarySchema,
  statsQuerySchema,
  subscriptionUsageSchema,
} from './records.js';
import { releaseMediaSchema, releasesSchema, repositorySchema } from './releases.js';
import {
  remoteMachineCreatedSchema,
  remoteMachineCreateSchema,
  remoteMachineDeleteSchema,
  remoteMachineRotatedSchema,
  remoteMachineSchema,
  remoteMachineUpdateSchema,
  remoteResultSchema,
  remoteWorkerPollSchema,
  remoteWorkerResultSchema,
} from './remote.js';
import {
  gatewaySettingsPatchSchema,
  gatewaySettingsSchema,
  scheduleInputSchema,
  schedulePatchSchema,
  scheduleRecordSchema,
  scheduleRunSchema,
} from './schedules.js';
import { panelSessionEndSchema, panelSessionInputSchema, panelSessionSchema } from './security.js';
import { skillImportSchema } from './skills.js';
import { sshKeyCreateSchema, sshKeySchema } from './ssh.js';
import { webSearchInputSchema, webSearchStatusSchema } from './web.js';
import { conversationSubagentSchema } from './work.js';
import {
  sessionWorktreeSchema,
  worktreeParamsSchema,
  worktreeUpdateInputSchema,
} from './worktrees.js';

/**
 * `access` is the whole authorization model. Everything marked `admin` opens to the owner, with
 * any of three credentials: the host token, the panel's signed cookie traded for it, or the token
 * of a paired phone, which has the owner's access. Rotating the host token ends every cookie;
 * revoking a phone ends its token alone. `public` routes carry their own proof in the body, and a
 * webhook authenticates with the token of its own channel binding.
 */
export type Operation = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  operationId: string;
  access: 'admin' | 'public' | 'webhook';
  body?: z.ZodType;
  query?: z.ZodType;
  // Path parameters are UUIDs unless an operation says otherwise.
  params?: z.ZodType;
  response: z.ZodType;
  status?: number;
  stream?: boolean;
  responseContentType?: 'text/plain';
  /**
   * The body of every refusal, for an operation that speaks another API's dialect. Absent,
   * refusals share the gateway's own error body.
   */
  failure?: z.ZodType;
};

const profile = '/v1/profiles/:profileId';
const session = `${profile}/sessions/:sessionId`;

export const cursorSchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});

/**
 * Where a stream resumes. No default, unlike a page of the feed: absent means from now, and the
 * stream opens with `STREAM_OPENED_EVENT`, whose id is the cursor to resume from. A stream says
 * which conversation an event concerns, not its whole data; the paged feed has that.
 */
export const streamCursorSchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  /**
   * `1` asks for what each working run is writing in its `run.progress` frames: up to 8000
   * characters, four times a second, per run. Only a client that shows the text asks for it;
   * any other hears that a run moved, as before.
   */
  progress: z.literal('1').optional(),
});

export const STREAM_OPENED_EVENT = 'stream.opened';

/** How many messages one read of a conversation returns, newest first to be read. */
export const MESSAGES_PAGE = 100;

/** How many messages the panel asks for when it opens a conversation and for each earlier page. */
export const MESSAGES_FIRST_PAGE = 40;

/**
 * The page before a message of the conversation; absent, the conversation's latest messages.
 * `limit` asks for fewer than a full page; absent, the gateway returns `MESSAGES_PAGE`.
 */
export const messagePageSchema = z.strictObject({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MESSAGES_PAGE).optional(),
});

/**
 * The turns to read the tools of, comma-separated, however old; absent, the latest turns. A list,
 * so a reader asks for exactly the turns it shows, and a page of messages never lacks its tools.
 */
export const timelineQuerySchema = z.strictObject({ runs: z.string().max(8_000).optional() });

export const operations: Operation[] = [
  {
    method: 'GET',
    path: '/v1/integrations/github',
    operationId: 'githubIntegration',
    access: 'admin',
    response: githubIntegrationStatusSchema,
  },
  {
    method: 'POST',
    path: '/v1/integrations/github/manifest',
    operationId: 'startGithubAppRegistration',
    access: 'admin',
    body: githubInstallInputSchema,
    response: githubManifestSchema,
  },
  {
    method: 'POST',
    path: '/v1/integrations/github/install',
    operationId: 'startGithubInstallation',
    access: 'admin',
    body: githubInstallInputSchema,
    response: githubInstallSchema,
  },
  {
    method: 'GET',
    path: '/v1/integrations/github/manifest/callback',
    operationId: 'completeGithubAppRegistration',
    access: 'public',
    query: z.looseObject({
      code: z.string().min(1).max(500).optional(),
      state: z.string().min(1).max(128).optional(),
    }),
    response: z.string(),
    status: 302,
    responseContentType: 'text/plain',
  },
  {
    method: 'GET',
    path: '/v1/integrations/github/callback',
    operationId: 'completeGithubInstallation',
    access: 'public',
    query: z.looseObject({
      code: z.string().min(1).max(500).optional(),
      state: z.string().min(1).max(128).optional(),
      installation_id: z.coerce.number().int().positive().safe().optional(),
      error: z.string().max(100).optional(),
    }),
    response: z.string(),
    status: 302,
    responseContentType: 'text/plain',
  },
  {
    method: 'GET',
    path: '/v1/integrations/github/repositories',
    operationId: 'githubRepositories',
    access: 'admin',
    response: z.array(githubConnectedRepositorySchema),
  },
  {
    method: 'DELETE',
    path: '/v1/integrations/github/installations/:accountId',
    operationId: 'disconnectGithubInstallation',
    access: 'admin',
    params: z.strictObject({ accountId: z.uuid() }),
    response: z.strictObject({ id: z.uuid() }),
  },
  {
    method: 'GET',
    path: '/v1/integrations/x',
    operationId: 'xIntegration',
    access: 'admin',
    response: xIntegrationStatusSchema,
  },
  {
    method: 'PUT',
    path: '/v1/integrations/x/app',
    operationId: 'saveXApp',
    access: 'admin',
    body: xAppInputSchema,
    response: xIntegrationStatusSchema,
  },
  {
    method: 'POST',
    path: '/v1/integrations/x/connect',
    operationId: 'startXConnection',
    access: 'admin',
    response: xConnectSchema,
  },
  {
    method: 'GET',
    path: '/v1/integrations/x/callback',
    operationId: 'completeXConnection',
    access: 'public',
    query: z.looseObject({
      code: z.string().min(1).max(2000).optional(),
      state: z.string().min(1).max(128).optional(),
      error: z.string().max(100).optional(),
    }),
    response: z.string(),
    status: 302,
    responseContentType: 'text/plain',
  },
  {
    method: 'DELETE',
    path: '/v1/integrations/x/accounts/:accountId',
    operationId: 'disconnectXAccount',
    access: 'admin',
    params: z.strictObject({ accountId: z.uuid() }),
    response: z.strictObject({ id: z.uuid() }),
  },
  {
    method: 'GET',
    path: '/v1/integrations/github/pulls/:owner/:repo/:number',
    operationId: 'getGithubPull',
    access: 'admin',
    params: githubItemParamsSchema,
    response: githubPullSchema,
  },
  {
    method: 'GET',
    path: '/v1/integrations/github/pulls/:owner/:repo/:number/file',
    operationId: 'getGithubPullFile',
    access: 'admin',
    params: githubItemParamsSchema,
    query: githubPullFileQuerySchema,
    response: githubPullFileLinesSchema,
  },
  {
    method: 'POST',
    path: '/v1/integrations/github/pulls/:owner/:repo/:number/ready-for-review',
    operationId: 'markGithubPullReady',
    access: 'admin',
    params: githubItemParamsSchema,
    body: githubMarkReadyInputSchema,
    response: githubMarkReadyResultSchema,
  },
  {
    method: 'POST',
    path: '/v1/integrations/github/pulls/:owner/:repo/:number/merge',
    operationId: 'mergeGithubPull',
    access: 'admin',
    params: githubItemParamsSchema,
    body: githubMergeInputSchema,
    response: githubMergeResultSchema,
  },
  {
    method: 'POST',
    path: '/v1/integrations/github/pulls/:owner/:repo/:number/update-branch',
    operationId: 'updateGithubPullBranch',
    access: 'admin',
    params: githubItemParamsSchema,
    body: githubUpdateBranchInputSchema,
    response: githubUpdateBranchResultSchema,
  },
  {
    method: 'GET',
    path: '/v1/integrations/github/issues/:owner/:repo/:number',
    operationId: 'getGithubIssue',
    access: 'admin',
    params: githubItemParamsSchema,
    response: githubIssueSchema,
  },
  {
    method: 'POST',
    path: '/v1/integrations/github/links',
    operationId: 'resolveGithubLinks',
    access: 'admin',
    body: githubLinksInputSchema,
    response: z.array(githubLinkSummarySchema),
  },
  {
    method: 'GET',
    path: '/v1/remote/machines',
    operationId: 'listRemoteMachines',
    access: 'admin',
    response: z.array(remoteMachineSchema),
  },
  {
    method: 'POST',
    path: '/v1/remote/machines',
    operationId: 'createRemoteMachine',
    access: 'admin',
    body: remoteMachineCreateSchema,
    response: remoteMachineCreatedSchema,
    status: 201,
  },
  {
    method: 'POST',
    path: '/v1/remote/machines/:machineId/rotate',
    operationId: 'rotateRemoteMachineCredentials',
    access: 'admin',
    params: z.strictObject({ machineId: z.uuid() }),
    response: remoteMachineRotatedSchema,
  },
  {
    method: 'POST',
    path: '/v1/remote/machines/:machineId/update',
    operationId: 'updateRemoteMachine',
    access: 'admin',
    params: z.strictObject({ machineId: z.uuid() }),
    response: remoteMachineUpdateSchema,
  },
  {
    method: 'DELETE',
    path: '/v1/remote/machines/:machineId',
    operationId: 'deleteRemoteMachine',
    access: 'admin',
    params: z.strictObject({ machineId: z.uuid() }),
    response: remoteMachineDeleteSchema,
  },
  {
    method: 'GET',
    path: '/v1/remote/worker/:machineId/tasks/next',
    operationId: 'pollRemoteTask',
    access: 'webhook',
    params: z.strictObject({ machineId: z.uuid() }),
    response: remoteWorkerPollSchema,
  },
  {
    method: 'POST',
    path: '/v1/remote/worker/:machineId/disconnect',
    operationId: 'disconnectRemoteWorker',
    access: 'webhook',
    params: z.strictObject({ machineId: z.uuid() }),
    response: remoteWorkerResultSchema,
  },
  {
    method: 'POST',
    path: '/v1/remote/worker/:machineId/tasks/:taskId/result',
    operationId: 'completeRemoteTask',
    access: 'webhook',
    params: z.strictObject({ machineId: z.uuid(), taskId: z.uuid() }),
    body: remoteResultSchema,
    response: remoteWorkerResultSchema,
  },
  {
    method: 'GET',
    path: '/v1/ssh-keys',
    operationId: 'listSshKeys',
    access: 'admin',
    response: z.array(sshKeySchema),
  },
  {
    method: 'POST',
    path: '/v1/ssh-keys',
    operationId: 'createSshKey',
    access: 'admin',
    body: sshKeyCreateSchema,
    response: sshKeySchema,
    status: 201,
  },
  {
    method: 'DELETE',
    path: '/v1/ssh-keys/:keyId',
    operationId: 'deleteSshKey',
    access: 'admin',
    params: z.strictObject({ keyId: z.uuid() }),
    response: z.strictObject({ id: z.uuid() }),
  },
  {
    method: 'GET',
    path: `${profile}/sessions/:sessionId/subagents`,
    operationId: 'listConversationSubagents',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), sessionId: z.uuid() }),
    response: z.array(conversationSubagentSchema),
  },
  {
    method: 'GET',
    path: '/v1/releases',
    operationId: 'getReleases',
    access: 'admin',
    response: releasesSchema,
  },
  {
    method: 'POST',
    path: '/v1/releases/seen',
    operationId: 'markReleasesSeen',
    access: 'admin',
    response: releasesSchema,
  },
  {
    method: 'GET',
    path: '/v1/releases/media/:file',
    operationId: 'readReleaseMedia',
    access: 'admin',
    params: z.strictObject({ file: z.string().max(128) }),
    response: releaseMediaSchema,
  },
  {
    method: 'GET',
    path: '/v1/repository',
    operationId: 'getRepository',
    access: 'admin',
    response: repositorySchema,
  },
  {
    method: 'GET',
    path: '/v1/web-search',
    operationId: 'getWebSearch',
    access: 'admin',
    response: webSearchStatusSchema,
  },
  {
    method: 'PUT',
    path: '/v1/web-search',
    operationId: 'setWebSearch',
    access: 'admin',
    body: webSearchInputSchema,
    response: webSearchStatusSchema,
  },
  {
    method: 'DELETE',
    path: '/v1/web-search',
    operationId: 'removeWebSearch',
    access: 'admin',
    response: webSearchStatusSchema,
  },
  {
    method: 'GET',
    path: '/v1/decisions',
    operationId: 'getDecisions',
    access: 'admin',
    response: decisionsStatusSchema,
  },
  {
    method: 'PUT',
    path: '/v1/decisions',
    operationId: 'setDecisions',
    access: 'admin',
    body: decisionsInputSchema,
    response: decisionsStatusSchema,
  },
  {
    method: 'PATCH',
    path: '/v1/decisions',
    operationId: 'updateDecisionsSettings',
    access: 'admin',
    body: decisionsSettingsPatchSchema,
    response: decisionsStatusSchema,
  },
  {
    method: 'DELETE',
    path: '/v1/decisions',
    operationId: 'removeDecisions',
    access: 'admin',
    response: decisionsStatusSchema,
  },
  {
    method: 'POST',
    path: '/v1/providers/openai/oauth',
    operationId: 'startCodexLogin',
    access: 'admin',
    response: codexLoginSchema,
  },
  {
    method: 'GET',
    path: '/v1/providers/openai/oauth',
    operationId: 'getCodexLogin',
    access: 'admin',
    response: codexLoginSchema,
  },
  {
    method: 'GET',
    path: '/v1/providers',
    operationId: 'listProviders',
    access: 'admin',
    response: z.array(providerRecordSchema),
  },
  {
    method: 'POST',
    path: '/v1/providers',
    operationId: 'createProvider',
    access: 'admin',
    body: providerInputSchema,
    response: providerRecordSchema,
    status: 201,
  },
  {
    method: 'GET',
    path: '/v1/providers/:providerId/models',
    operationId: 'listProviderModels',
    access: 'admin',
    response: providerModelListSchema,
  },
  {
    method: 'DELETE',
    path: '/v1/providers/:providerId',
    operationId: 'revokeProvider',
    access: 'admin',
    response: providerRecordSchema,
  },
  {
    method: 'GET',
    path: '/v1/model-defaults',
    operationId: 'getModelDefaults',
    access: 'admin',
    response: modelDefaultsRecordSchema,
  },
  {
    method: 'PUT',
    path: '/v1/model-defaults',
    operationId: 'setModelDefaults',
    access: 'admin',
    body: modelDefaultsInputSchema,
    response: modelDefaultsRecordSchema,
  },
  {
    method: 'GET',
    path: '/openapi.json',
    operationId: 'getOpenAPI',
    access: 'admin',
    response: z.record(z.string(), z.unknown()),
  },
  {
    method: 'GET',
    path: `${profile}/runs/:runId/checkpoints`,
    operationId: 'listRunCheckpoints',
    access: 'admin',
    response: z.array(checkpointSchema),
  },
  {
    method: 'POST',
    path: `${profile}/runs/:runId/continue`,
    operationId: 'continueRun',
    access: 'admin',
    body: continuationSchema,
    response: runRecordSchema,
    status: 202,
  },
  {
    // The panel's approve and reject. A WhatsApp or Telegram conversation is decided in its
    // own chat, by a contact allowed to, and refuses this route.
    method: 'POST',
    path: `${profile}/runs/:runId/approval`,
    operationId: 'decideApproval',
    access: 'admin',
    body: runApprovalInputSchema,
    response: runRecordSchema,
    status: 202,
  },
  {
    method: 'POST',
    path: `${profile}/runs/:runId/answer`,
    operationId: 'answerRun',
    access: 'admin',
    body: runAnswerSchema,
    response: runRecordSchema,
    status: 202,
  },
  {
    method: 'POST',
    path: `${profile}/channels`,
    operationId: 'createChannel',
    access: 'admin',
    body: channelInputSchema,
    response: channelSchema.extend({
      webhookToken: z.string(),
      // Present when the gateway tried to register its webhook with the protocol itself.
      webhookRegistered: z.boolean().optional(),
      // What the protocol said when it refused the webhook, for the owner to act on.
      webhookError: z.string().optional(),
    }),
    status: 201,
  },
  {
    method: 'GET',
    path: `${profile}/channels`,
    operationId: 'listChannels',
    access: 'admin',
    response: z.array(channelSchema),
  },
  {
    method: 'PATCH',
    path: `${profile}/channels/:channelId`,
    operationId: 'updateChannel',
    access: 'admin',
    body: channelPatchSchema,
    response: channelSchema,
  },
  {
    method: 'DELETE',
    path: `${profile}/channels/:channelId`,
    operationId: 'revokeChannel',
    access: 'admin',
    response: channelSchema,
  },
  {
    method: 'GET',
    path: `${profile}/contacts`,
    operationId: 'listContacts',
    access: 'admin',
    response: z.array(contactSchema),
  },
  {
    method: 'PATCH',
    path: `${profile}/contacts/:id`,
    operationId: 'updateContact',
    access: 'admin',
    body: contactPatchSchema,
    response: contactSchema,
  },
  {
    method: 'POST',
    path: `${profile}/contacts/:contactId/approve`,
    operationId: 'approveContact',
    access: 'admin',
    response: contactSchema,
  },
  {
    method: 'POST',
    path: `${profile}/contacts/:contactId/block`,
    operationId: 'blockContact',
    access: 'admin',
    response: contactSchema,
  },
  {
    // Rooms cross profiles by nature: one group holds several agents of this installation, and
    // the owner decides about the room, not about one profile's view of it.
    method: 'GET',
    path: '/v1/groups',
    operationId: 'listGroups',
    access: 'admin',
    response: z.array(groupSchema),
  },
  {
    method: 'GET',
    path: `${profile}/deliveries`,
    operationId: 'listDeliveries',
    access: 'admin',
    response: z.array(deliverySchema),
  },
  {
    method: 'POST',
    path: `${profile}/channels/:channelId/connect`,
    operationId: 'connectChannel',
    access: 'admin',
    response: channelConnectionSchema,
    status: 202,
  },
  {
    method: 'GET',
    path: `${profile}/channels/:channelId/connection`,
    operationId: 'getChannelConnection',
    access: 'admin',
    response: channelConnectionSchema,
  },
  {
    method: 'GET',
    path: `${profile}/channels/:channelId/qr`,
    operationId: 'getChannelQr',
    access: 'admin',
    response: channelQrSchema,
  },
  {
    method: 'POST',
    path: `${profile}/channels/:channelId/disconnect`,
    operationId: 'disconnectChannel',
    access: 'admin',
    response: channelConnectionSchema,
    status: 202,
  },
  {
    method: 'POST',
    path: '/v1/ingress/:channelId',
    operationId: 'channelIngress',
    access: 'webhook',
    body: ingressSchema,
    response: ingressResultSchema,
    status: 202,
  },
  {
    method: 'GET',
    path: '/v1/channels/:channelId/openai/models',
    operationId: 'listChannelModels',
    access: 'webhook',
    response: openAiModelListSchema,
    failure: openAiErrorSchema,
  },
  {
    method: 'POST',
    path: '/v1/channels/:channelId/openai/chat/completions',
    operationId: 'createChannelChatCompletion',
    access: 'webhook',
    body: chatCompletionRequestSchema,
    response: chatCompletionSchema,
    failure: openAiErrorSchema,
  },
  {
    method: 'POST',
    path: '/v1/email/:channelId',
    operationId: 'emailIngress',
    access: 'webhook',
    body: z
      .unknown()
      .describe(
        'A Resend webhook event, authenticated with its Svix signature over the original bytes. Maximum 256 KB.',
      ),
    response: ingressResultSchema,
  },
  {
    method: 'POST',
    path: '/v1/telegram/:channelId',
    operationId: 'telegramIngress',
    access: 'webhook',
    body: telegramUpdateSchema,
    response: ingressResultSchema,
  },
  {
    method: 'GET',
    path: `${profile}/sessions/:sessionId/history`,
    operationId: 'getHistory',
    access: 'admin',
    query: pageQuerySchema,
    response: z.strictObject({
      items: z.array(messageRecordSchema),
      nextCursor: z.string().nullable(),
    }),
  },
  {
    method: 'GET',
    path: `${profile}/history`,
    operationId: 'searchHistory',
    access: 'admin',
    query: pageQuerySchema,
    response: z.strictObject({
      items: z.array(messageRecordSchema),
      nextCursor: z.string().nullable(),
    }),
  },
  {
    method: 'GET',
    path: `${profile}/artifacts/:artifactId`,
    operationId: 'getArtifact',
    access: 'admin',
    query: artifactQuerySchema,
    response: artifactPageSchema,
  },
  {
    method: 'POST',
    path: `${profile}/leases`,
    operationId: 'acquireResource',
    access: 'admin',
    body: leaseInputSchema,
    response: leaseSchema,
  },
  {
    method: 'POST',
    path: `${profile}/leases/release`,
    operationId: 'releaseResource',
    access: 'admin',
    body: leaseInputSchema
      .omit({ ttlSeconds: true })
      .extend({ fence: z.number().int().positive() }),
    response: leaseSchema,
  },
  {
    method: 'POST',
    path: `${profile}/mail`,
    operationId: 'sendSessionMail',
    access: 'admin',
    body: mailInputSchema,
    response: mailSchema,
  },
  {
    method: 'GET',
    path: `${session}/mail`,
    operationId: 'getSessionInbox',
    access: 'admin',
    response: z.array(mailSchema),
  },

  {
    method: 'GET',
    path: '/health',
    operationId: 'health',
    access: 'public',
    // `version` is the running release (JIAN_VERSION). Absent on local/dev builds. Remote
    // Control uses it for the major.minor compatibility gate.
    response: z.strictObject({
      status: z.literal('ok'),
      service: z.literal('jian'),
      version: z
        .string()
        .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
        .optional(),
      // `local` is the gateway a desktop app runs on the owner's computer: no channels and no
      // webhooks, as nothing outside reaches it. The panel leaves out what cannot work there.
      mode: z.enum(['server', 'local']).optional(),
    }),
  },
  {
    // Public because the body carries the host token this route exists to verify.
    method: 'POST',
    path: '/v1/panel/session',
    operationId: 'startPanelSession',
    access: 'public',
    body: panelSessionInputSchema,
    response: panelSessionSchema,
    status: 201,
  },
  {
    method: 'DELETE',
    path: '/v1/panel/session',
    operationId: 'endPanelSession',
    access: 'admin',
    response: panelSessionEndSchema,
  },
  {
    method: 'POST',
    path: '/v1/devices/pairings',
    operationId: 'createDevicePairing',
    access: 'admin',
    response: devicePairingSchema,
    status: 201,
  },
  {
    // Public because the phone has no token yet; the single-use code from the QR is its proof.
    method: 'POST',
    path: '/v1/devices/pair',
    operationId: 'pairDevice',
    access: 'public',
    body: devicePairInputSchema,
    response: devicePairedSchema,
    status: 201,
  },
  {
    method: 'GET',
    path: '/v1/devices',
    operationId: 'listDevices',
    access: 'admin',
    response: z.array(deviceSchema),
  },
  {
    method: 'GET',
    path: '/v1/devices/self',
    operationId: 'currentDevice',
    access: 'admin',
    response: deviceSchema,
  },
  {
    method: 'PUT',
    path: '/v1/devices/self/push',
    operationId: 'setDevicePush',
    access: 'admin',
    body: devicePushInputSchema,
    response: deviceSchema,
  },
  {
    method: 'PUT',
    path: '/v1/devices/self/focus',
    operationId: 'setDeviceFocus',
    access: 'admin',
    body: deviceFocusInputSchema,
    response: z.null(),
    status: 204,
  },
  {
    method: 'DELETE',
    path: '/v1/devices/self',
    operationId: 'unpairDevice',
    access: 'admin',
    response: z.null(),
    status: 204,
  },
  {
    method: 'PATCH',
    path: '/v1/devices/:deviceId',
    operationId: 'updateDevice',
    access: 'admin',
    body: devicePatchSchema,
    response: deviceSchema,
  },
  {
    method: 'DELETE',
    path: '/v1/devices/:deviceId',
    operationId: 'revokeDevice',
    access: 'admin',
    response: z.null(),
    status: 204,
  },
  {
    method: 'GET',
    path: '/v1/mcp-servers',
    operationId: 'listMcpServers',
    access: 'admin',
    response: mcpServerListSchema,
  },
  {
    method: 'PUT',
    path: '/v1/mcp-servers',
    operationId: 'replaceMcpServers',
    access: 'admin',
    body: mcpServerListInputSchema,
    response: mcpServerListSchema,
  },
  {
    // The form's Test connection: nothing is stored, so a draft the owner drops leaves no trace.
    method: 'POST',
    path: '/v1/mcp-servers/check',
    operationId: 'checkMcpDraft',
    access: 'admin',
    body: mcpDraftCheckSchema,
    response: mcpStatusSchema,
  },
  {
    // A check the owner asks for, so it runs the connection now instead of reading a cache.
    method: 'POST',
    path: '/v1/mcp-servers/:name/check',
    operationId: 'checkMcpServer',
    access: 'admin',
    params: z.strictObject({ name: z.string().regex(/^[a-z0-9_]{1,30}$/) }),
    response: mcpStatusSchema,
  },
  {
    // The authorization server sends the owner's browser here, so it answers HTML and carries
    // its proof in the query rather than in a header the redirect could not add.
    method: 'GET',
    path: '/v1/mcp-servers/:name/oauth/callback',
    operationId: 'completeMcpLogin',
    access: 'public',
    params: z.strictObject({ name: z.string().regex(/^[a-z0-9_]{1,30}$/) }),
    query: z.looseObject({ code: z.string().optional(), state: z.string().optional() }),
    response: z.string(),
  },
  {
    method: 'GET',
    path: `${profile}/activity`,
    operationId: 'getActivityCalendar',
    access: 'admin',
    query: activityQuerySchema,
    response: z.array(activityDaySchema).max(400),
  },
  {
    method: 'GET',
    path: `${profile}/built-in-skills`,
    operationId: 'listBuiltinSkills',
    access: 'admin',
    response: z.array(builtinSkillSchema).max(50),
  },
  {
    method: 'POST',
    path: `${profile}/skills/import`,
    operationId: 'importSkill',
    access: 'admin',
    body: skillImportSchema,
    response: profileRecordSchema,
  },
  {
    method: 'GET',
    path: '/v1/profiles',
    operationId: 'listProfiles',
    access: 'admin',
    response: z.array(profileRecordSchema),
  },
  {
    method: 'POST',
    path: '/v1/profiles',
    operationId: 'createProfile',
    access: 'admin',
    body: profileSchema,
    response: profileRecordSchema,
    status: 201,
  },
  {
    method: 'GET',
    path: profile,
    operationId: 'getProfile',
    access: 'admin',
    response: profileRecordSchema,
  },
  {
    method: 'PATCH',
    path: profile,
    operationId: 'updateProfile',
    access: 'admin',
    body: profilePatchSchema,
    response: profileRecordSchema,
  },
  {
    // Everything the profile ever wrote — sessions, memories, channels, contacts, runs, media —
    // cascades from this row in the database, so the confirmation the owner sees is the whole
    // truth: nothing survives it.
    method: 'DELETE',
    path: profile,
    operationId: 'deleteProfile',
    access: 'admin',
    response: z.strictObject({ id: z.uuid() }),
  },
  {
    // Forgetting, not deleting: sessions, memories and activity go; configuration, channels
    // and contacts stay.
    method: 'POST',
    path: `${profile}/reset`,
    operationId: 'resetProfile',
    access: 'admin',
    response: z.strictObject({
      id: z.uuid(),
      sessions: z.number().int().nonnegative(),
      memories: z.number().int().nonnegative(),
    }),
  },
  {
    method: 'GET',
    path: `${profile}/revisions`,
    operationId: 'listRevisions',
    access: 'admin',
    response: z.array(revisionRecordSchema),
  },
  {
    method: 'GET',
    path: `${profile}/sessions`,
    operationId: 'listSessions',
    access: 'admin',
    response: z.array(sessionSummarySchema),
  },
  {
    method: 'GET',
    path: `${profile}/projects`,
    operationId: 'listProjects',
    access: 'admin',
    response: z.array(projectSchema),
  },
  {
    method: 'POST',
    path: `${profile}/projects`,
    operationId: 'ensureProject',
    access: 'admin',
    body: projectInputSchema,
    response: projectSchema,
  },
  {
    method: 'POST',
    path: `${profile}/gateway-sessions`,
    operationId: 'createGatewaySession',
    access: 'admin',
    body: gatewaySessionInputSchema,
    response: sessionRecordSchema,
    status: 201,
  },
  {
    method: 'PUT',
    path: `${session}/target`,
    operationId: 'setGatewaySessionTarget',
    access: 'admin',
    body: gatewaySessionTargetSchema,
    response: sessionRecordSchema,
  },
  {
    method: 'POST',
    path: `${profile}/sessions`,
    operationId: 'createSession',
    access: 'admin',
    body: sessionSchema,
    response: sessionRecordSchema,
    status: 201,
  },
  {
    method: 'PUT',
    path: `${session}/pin`,
    operationId: 'setSessionPin',
    access: 'admin',
    body: sessionPinSchema,
    response: sessionRecordSchema,
  },
  {
    method: 'PATCH',
    path: session,
    operationId: 'renameSession',
    access: 'admin',
    body: sessionRenameSchema,
    response: sessionRecordSchema,
  },
  {
    method: 'DELETE',
    path: session,
    operationId: 'deleteSession',
    access: 'admin',
    response: sessionRecordSchema,
  },
  {
    method: 'PUT',
    path: `${session}/model`,
    operationId: 'setSessionModel',
    access: 'admin',
    body: sessionModelSchema,
    response: sessionRecordSchema,
  },
  {
    method: 'PUT',
    path: `${session}/protection`,
    operationId: 'setSessionProtection',
    access: 'admin',
    body: sessionProtectionSchema,
    response: sessionRecordSchema,
  },
  {
    method: 'GET',
    path: '/v1/push/key',
    operationId: 'getPushKey',
    access: 'admin',
    response: pushKeySchema,
  },
  {
    method: 'PUT',
    path: '/v1/push/subscriptions',
    operationId: 'subscribePush',
    access: 'admin',
    body: pushSubscriptionInputSchema,
    response: pushEndpointSchema,
  },
  {
    method: 'POST',
    path: '/v1/push/subscriptions/remove',
    operationId: 'unsubscribePush',
    access: 'admin',
    body: pushEndpointSchema,
    response: pushEndpointSchema,
  },
  {
    method: 'POST',
    path: `${session}/read`,
    operationId: 'markSessionRead',
    access: 'admin',
    response: sessionRecordSchema,
  },
  {
    method: 'GET',
    path: `${session}/pull-requests`,
    operationId: 'listSessionPullRequests',
    access: 'admin',
    response: z.array(sessionPullSchema),
  },
  {
    method: 'POST',
    path: `${session}/github/fix-conflicts`,
    operationId: 'fixGithubConflicts',
    access: 'admin',
    body: githubFixConflictsInputSchema,
    response: runRecordSchema,
    status: 202,
  },
  {
    method: 'GET',
    path: `${session}/worktrees`,
    operationId: 'listSessionWorktrees',
    access: 'admin',
    response: z.array(sessionWorktreeSchema),
  },
  {
    method: 'POST',
    path: `${session}/worktrees/:name/merge`,
    operationId: 'mergeSessionWorktree',
    access: 'admin',
    params: worktreeParamsSchema,
    response: runRecordSchema,
    status: 202,
  },
  {
    method: 'POST',
    path: `${session}/worktrees/:name/update`,
    operationId: 'updateSessionWorktree',
    access: 'admin',
    params: worktreeParamsSchema,
    body: worktreeUpdateInputSchema,
    response: runRecordSchema,
    status: 202,
  },
  {
    method: 'POST',
    path: `${session}/worktrees/:name/pull-request`,
    operationId: 'openWorktreePullRequest',
    access: 'admin',
    params: worktreeParamsSchema,
    response: runRecordSchema,
    status: 202,
  },
  {
    method: 'DELETE',
    path: `${session}/worktrees/:name`,
    operationId: 'discardSessionWorktree',
    access: 'admin',
    params: worktreeParamsSchema,
    response: z.null(),
    status: 204,
  },
  {
    method: 'PUT',
    path: `${session}/objective`,
    operationId: 'setSessionObjective',
    access: 'admin',
    body: sessionObjectiveInputSchema,
    response: sessionRecordSchema,
  },
  {
    method: 'GET',
    path: '/v1/profiles/:profileId/media/:mediaId',
    operationId: 'readMedia',
    access: 'admin',
    response: mediaContentSchema,
  },
  {
    method: 'GET',
    path: `${session}/messages`,
    operationId: 'listMessages',
    access: 'admin',
    query: messagePageSchema,
    response: z.array(messageRecordSchema),
  },
  {
    method: 'POST',
    path: `${session}/media`,
    operationId: 'uploadMedia',
    access: 'admin',
    body: inlineMediaSchema,
    response: mediaRecordSchema,
    status: 201,
  },
  {
    method: 'GET',
    path: `${session}/timeline`,
    operationId: 'listSessionTimeline',
    access: 'admin',
    query: timelineQuerySchema,
    response: z.array(runTimelineSchema),
  },
  {
    method: 'GET',
    path: `${session}/changes`,
    operationId: 'listSessionChanges',
    access: 'admin',
    query: sessionChangesQuerySchema,
    response: sessionChangesSchema,
  },
  {
    method: 'GET',
    path: `${session}/context`,
    operationId: 'getSessionContext',
    access: 'admin',
    response: sessionContextSchema,
  },
  {
    method: 'GET',
    path: `${session}/people`,
    operationId: 'listSessionPeople',
    access: 'admin',
    response: z.array(personSchema),
  },
  {
    method: 'POST',
    path: `${session}/messages`,
    operationId: 'submitMessage',
    access: 'admin',
    body: submitSchema,
    response: runRecordSchema,
    status: 202,
  },
  {
    method: 'PUT',
    path: `${session}/messages/{messageId}/reaction`,
    operationId: 'setMessageReaction',
    access: 'admin',
    body: messageReactionInputSchema,
    response: messageRecordSchema,
  },
  {
    method: 'GET',
    path: `${profile}/schedules`,
    operationId: 'listSchedules',
    access: 'admin',
    response: z.array(scheduleRecordSchema),
  },
  {
    method: 'POST',
    path: `${profile}/schedules`,
    operationId: 'createSchedule',
    access: 'admin',
    body: scheduleInputSchema,
    response: scheduleRecordSchema,
    status: 201,
  },
  {
    method: 'PATCH',
    path: `${profile}/schedules/:scheduleId`,
    operationId: 'updateSchedule',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), scheduleId: z.uuid() }),
    body: schedulePatchSchema,
    response: scheduleRecordSchema,
  },
  {
    method: 'DELETE',
    path: `${profile}/schedules/:scheduleId`,
    operationId: 'deleteSchedule',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), scheduleId: z.uuid() }),
    response: scheduleRecordSchema,
  },
  {
    method: 'GET',
    path: `${profile}/schedules/:scheduleId/history`,
    operationId: 'listScheduleRuns',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), scheduleId: z.uuid() }),
    response: z.array(scheduleRunSchema),
  },
  {
    method: 'GET',
    path: '/v1/settings',
    operationId: 'getSettings',
    access: 'admin',
    response: gatewaySettingsSchema,
  },
  {
    method: 'PUT',
    path: '/v1/settings',
    operationId: 'updateSettings',
    access: 'admin',
    body: gatewaySettingsPatchSchema,
    response: gatewaySettingsSchema,
  },
  {
    // Now, once, without moving when it runs next: to see what it does before waiting for it.
    method: 'POST',
    path: `${profile}/schedules/:scheduleId/run`,
    operationId: 'runSchedule',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), scheduleId: z.uuid() }),
    response: runRecordSchema,
    status: 202,
  },
  {
    method: 'GET',
    path: `${profile}/memories`,
    operationId: 'listMemories',
    access: 'admin',
    response: z.array(memoryRecordSchema),
  },
  {
    method: 'PUT',
    path: `${profile}/memories/:memoryKey`,
    operationId: 'editMemory',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), memoryKey: memoryKeySchema }),
    body: memoryEditSchema,
    response: memoryRecordSchema,
  },
  {
    method: 'DELETE',
    path: `${profile}/memories/:memoryKey`,
    operationId: 'forgetMemory',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), memoryKey: memoryKeySchema }),
    response: memoryRecordSchema,
  },
  {
    // Links go both ways: linking a to b is linking b to a, and the answer is `memoryKey`.
    method: 'PUT',
    path: `${profile}/memories/:memoryKey/links/:linkedKey`,
    operationId: 'linkMemories',
    access: 'admin',
    params: z.strictObject({
      profileId: z.uuid(),
      memoryKey: memoryKeySchema,
      linkedKey: memoryKeySchema,
    }),
    response: memoryRecordSchema,
  },
  {
    method: 'DELETE',
    path: `${profile}/memories/:memoryKey/links/:linkedKey`,
    operationId: 'unlinkMemories',
    access: 'admin',
    params: z.strictObject({
      profileId: z.uuid(),
      memoryKey: memoryKeySchema,
      linkedKey: memoryKeySchema,
    }),
    response: memoryRecordSchema,
  },
  {
    method: 'GET',
    path: `${profile}/stats`,
    operationId: 'getProfileStats',
    access: 'admin',
    query: statsQuerySchema,
    response: profileStatsSchema,
  },
  {
    method: 'GET',
    path: '/v1/subscription-usage',
    operationId: 'listSubscriptionUsage',
    access: 'admin',
    response: z.array(subscriptionUsageSchema),
  },
  {
    method: 'GET',
    path: `${profile}/activities`,
    operationId: 'listActivities',
    access: 'admin',
    response: z.array(runRecordSchema),
  },
  {
    method: 'GET',
    path: `${profile}/runs/:runId`,
    operationId: 'getRun',
    access: 'admin',
    response: runRecordSchema,
  },
  {
    method: 'POST',
    path: `${profile}/runs/:runId/cancel`,
    operationId: 'cancelRun',
    access: 'admin',
    response: runRecordSchema,
  },
  {
    method: 'GET',
    path: `${profile}/events`,
    operationId: 'listEvents',
    access: 'admin',
    query: cursorSchema,
    response: z.array(eventSchema),
  },
  {
    method: 'GET',
    path: `${profile}/events/stream`,
    operationId: 'streamEvents',
    access: 'admin',
    query: streamCursorSchema,
    response: z.string(),
    stream: true,
  },
];

export function jsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'input') {
  const { $schema: _dialect, ...result } = z.toJSONSchema(schema, { target: 'draft-7', io });

  return result;
}

/**
 * A failure body. `issues` names each field validation refused and why; without it in the
 * schema, the response serializer drops it and every validation failure reads only "Invalid
 * request".
 */
export const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, message: { type: 'string' } },
        required: ['path', 'message'],
        additionalProperties: false,
      },
    },
  },
  required: ['error'],
  additionalProperties: false,
};

export function operationSchema(operation: Operation) {
  const names = [...operation.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1] as string);
  const params =
    operation.params ??
    (names.length
      ? z.strictObject(Object.fromEntries(names.map((name) => [name, z.uuid()])))
      : undefined);

  const failure = operation.failure ? jsonSchema(operation.failure, 'output') : errorSchema;

  return {
    operationId: operation.operationId,
    ...(operation.body ? { body: jsonSchema(operation.body) } : {}),
    ...(operation.query ? { querystring: jsonSchema(operation.query) } : {}),
    ...(params ? { params: jsonSchema(params) } : {}),
    response: {
      [operation.status ?? 200]: jsonSchema(operation.response, 'output'),
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 413, 429, 500, 503].map((code) => [code, failure]),
      ),
    },
  };
}

type RouteSchema = ReturnType<typeof operationSchema>;

function securityRequirements(operation: Operation) {
  if (operation.access === 'public') {
    return [];
  }

  if (operation.access === 'webhook') {
    // An OpenAI client sends the channel token as its API key, a bearer; the channel's own
    // header is taken as well.
    if (operation.failure === openAiErrorSchema) {
      return [{ channelBearer: [] }, { channelWebhook: [] }];
    }

    const scheme =
      operation.operationId === 'telegramIngress' ? 'telegramWebhook' : 'channelWebhook';

    return [{ [scheme]: [] }];
  }

  return [{ bearerAuth: [] }];
}

function openAPIParameters(schema: RouteSchema) {
  const params = schema.params?.properties ?? {};
  const query = schema.querystring?.properties ?? {};

  return [
    ...Object.entries(params).map(([name, value]) => ({
      name,
      in: 'path',
      required: true,
      schema: value,
    })),
    ...Object.entries(query).map(([name, value]) => ({
      name,
      in: 'query',
      required: false,
      schema: value,
    })),
  ];
}

function openAPIResponses(operation: Operation, schema: RouteSchema) {
  return Object.fromEntries(
    Object.entries(schema.response).map(([code, value]) => {
      const contentType =
        operation.stream && code === '200'
          ? 'text/event-stream'
          : Number(code) < 400
            ? (operation.responseContentType ?? 'application/json')
            : 'application/json';

      // Every failure has the same body: one shared schema, not a copy in each response. An
      // operation in another dialect has its own, already inline.
      return [
        code,
        {
          description: Number(code) < 400 ? 'Success' : 'Error',
          content: {
            [contentType]: {
              schema:
                Number(code) < 400 || operation.failure
                  ? value
                  : { $ref: '#/components/schemas/Error' },
            },
          },
        },
      ];
    }),
  );
}

function openAPIOperation(operation: Operation) {
  const schema = operationSchema(operation);

  return {
    operationId: operation.operationId,
    security: securityRequirements(operation),
    description: `Required permission: ${operation.access}.`,
    parameters: openAPIParameters(schema),
    ...(schema.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schema.body } },
          },
        }
      : {}),
    responses: openAPIResponses(operation, schema),
  };
}

/** Runtime validation and client generation share the same operation definitions. */
export function createOpenAPI() {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const operation of operations) {
    const path = operation.path.replace(/:([A-Za-z]+)/g, '{$1}');

    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = openAPIOperation(operation);
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Jian Gateway', version: '0.2.0' },
    paths,
    components: {
      schemas: { Error: errorSchema },
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        telegramWebhook: { type: 'apiKey', in: 'header', name: 'X-Telegram-Bot-Api-Secret-Token' },
        channelWebhook: { type: 'apiKey', in: 'header', name: 'X-Jian-Channel-Token' },
        channelBearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'The API channel token, sent as an OpenAI client sends its API key.',
        },
      },
    },
  };
}
