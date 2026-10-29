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
  githubConnectedRepositorySchema,
  githubInstallInputSchema,
  githubInstallSchema,
  githubIntegrationStatusSchema,
  githubManifestSchema,
} from './integrations.js';
import { inlineMediaSchema, mediaContentSchema, mediaRecordSchema } from './media.js';
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
  sessionRecordSchema,
  sessionSummarySchema,
  statsQuerySchema,
} from './records.js';
import { releasesSchema, repositorySchema } from './releases.js';
import {
  remoteMachineCreatedSchema,
  remoteMachineCreateSchema,
  remoteMachineDeleteSchema,
  remoteMachineRotatedSchema,
  remoteMachineSchema,
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
import {
  subscriptionDeliverySchema,
  subscriptionInputSchema,
  subscriptionPatchSchema,
  subscriptionRecordSchema,
} from './subscriptions.js';
import { webSearchInputSchema, webSearchStatusSchema } from './web.js';
import { conversationSubagentSchema } from './work.js';

/**
 * `access` is the whole authorization model: the host token opens everything marked `admin`,
 * `public` routes carry their own proof in the body, and a webhook authenticates with the
 * token of its own channel binding.
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
};

const profile = '/v1/profiles/:profileId';
const session = `${profile}/sessions/:sessionId`;

export const cursorSchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});

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
    path: '/v1/whatsapp-business/:channelId',
    operationId: 'verifyWhatsAppBusinessWebhook',
    access: 'webhook',
    query: z.object({
      'hub.mode': z.literal('subscribe'),
      'hub.verify_token': z.string().max(16000),
      'hub.challenge': z.string().max(256),
    }),
    response: z.string().describe('The Meta challenge, returned as text/plain.'),
    responseContentType: 'text/plain',
  },
  {
    method: 'POST',
    path: '/v1/whatsapp-business/:channelId',
    operationId: 'whatsappBusinessIngress',
    access: 'webhook',
    body: z
      .unknown()
      .describe(
        'Meta webhook JSON authenticated with HMAC-SHA256 over the original bytes. Maximum 3 MB.',
      ),
    response: z.strictObject({ accepted: z.boolean() }),
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
    response: z.array(runTimelineSchema),
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
    path: `${profile}/subscriptions`,
    operationId: 'listSubscriptions',
    access: 'admin',
    response: z.array(subscriptionRecordSchema),
  },
  {
    method: 'POST',
    path: `${profile}/subscriptions`,
    operationId: 'createSubscription',
    access: 'admin',
    body: subscriptionInputSchema,
    response: subscriptionRecordSchema,
    status: 201,
  },
  {
    method: 'PATCH',
    path: `${profile}/subscriptions/:subscriptionId`,
    operationId: 'updateSubscription',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), subscriptionId: z.uuid() }),
    body: subscriptionPatchSchema,
    response: subscriptionRecordSchema,
  },
  {
    method: 'DELETE',
    path: `${profile}/subscriptions/:subscriptionId`,
    operationId: 'deleteSubscription',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), subscriptionId: z.uuid() }),
    response: subscriptionRecordSchema,
  },
  {
    method: 'GET',
    path: `${profile}/subscriptions/:subscriptionId/deliveries`,
    operationId: 'listSubscriptionDeliveries',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), subscriptionId: z.uuid() }),
    response: z.array(subscriptionDeliverySchema),
  },
  {
    method: 'POST',
    path: '/v1/hooks/github/:subscriptionId',
    operationId: 'githubSubscriptionWebhook',
    access: 'webhook',
    params: z.strictObject({ subscriptionId: z.uuid() }),
    // Body is the raw GitHub payload; verification uses X-Hub-Signature-256.
    body: z.record(z.string(), z.unknown()),
    response: z.strictObject({
      accepted: z.boolean(),
      runId: z.uuid().optional(),
    }),
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
    query: cursorSchema,
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

  return {
    operationId: operation.operationId,
    ...(operation.body ? { body: jsonSchema(operation.body) } : {}),
    ...(operation.query ? { querystring: jsonSchema(operation.query) } : {}),
    ...(params ? { params: jsonSchema(params) } : {}),
    response: {
      [operation.status ?? 200]: jsonSchema(operation.response, 'output'),
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 413, 429, 500, 503].map((code) => [code, errorSchema]),
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
    const scheme =
      operation.operationId === 'telegramIngress'
        ? 'telegramWebhook'
        : operation.operationId === 'whatsappBusinessIngress'
          ? 'metaSignature'
          : operation.operationId === 'verifyWhatsAppBusinessWebhook'
            ? 'metaVerifyToken'
            : 'channelWebhook';

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

      // Every failure has the same body: one shared schema, not a copy in each response.
      return [
        code,
        {
          description: Number(code) < 400 ? 'Success' : 'Error',
          content: {
            [contentType]: {
              schema: Number(code) < 400 ? value : { $ref: '#/components/schemas/Error' },
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
        metaSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Hub-Signature-256',
          description: 'sha256=<HMAC of the raw body using the Meta App Secret>',
        },
        metaVerifyToken: { type: 'apiKey', in: 'query', name: 'hub.verify_token' },
      },
    },
  };
}
