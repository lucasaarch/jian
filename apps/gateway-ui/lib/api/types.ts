import type { operations } from '@jian/sdk';

/** The body of a response, read straight off the generated operation so nothing is restated. */
type JsonResponse<
  K extends keyof operations,
  S extends keyof operations[K]['responses'],
> = operations[K]['responses'][S] extends { content: { 'application/json': infer T } } ? T : never;

type RequestBody<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { 'application/json': infer T } };
}
  ? T
  : never;

export type Profile = JsonResponse<'getProfile', 200>;
export type McpServer = JsonResponse<'listMcpServers', 200>[number];
export type McpValue = McpServer['headers'][number];
export type Skill = Profile['skills'][number];
export type Session = JsonResponse<'listSessions', 200>[number];
export type Project = JsonResponse<'listProjects', 200>[number];
export type ProjectChoice = RequestBody<'ensureProject'>;
export type Channel = JsonResponse<'listChannels', 200>[number];
export type ChannelType = Channel['type'];
export type Contact = JsonResponse<'listContacts', 200>[number];
export type Group = JsonResponse<'listGroups', 200>[number];
export type Memory = JsonResponse<'listMemories', 200>[number];
export type ProfileStats = JsonResponse<'getProfileStats', 200>;
export type BuiltinSkill = JsonResponse<'listBuiltinSkills', 200>[number];
export type McpStatus = JsonResponse<'checkMcpServer', 200>;
export type Run = JsonResponse<'getRun', 200>;
export type Message = JsonResponse<'listMessages', 200>[number];
export type Person = JsonResponse<'listSessionPeople', 200>[number];
type RunTimeline = JsonResponse<'listSessionTimeline', 200>[number];
export type ToolStep = RunTimeline['steps'][number];
export type CodeDiff = NonNullable<ToolStep['diff']>;
export type Subagent = JsonResponse<'listConversationSubagents', 200>[number];
export type ActivityDay = JsonResponse<'getActivityCalendar', 200>[number];

export type Provider = JsonResponse<'listProviders', 200>[number];
export type ModelDefaults = JsonResponse<'getModelDefaults', 200>;
export type ModelSelection = NonNullable<ModelDefaults['conversation']>;
export type ProtectionMode = RequestBody<'setSessionProtection'>['protection'];
export type RunApproval = NonNullable<RunTimeline['approval']>;
export type ReasoningEffort = NonNullable<ModelSelection['reasoningEffort']>;
export type ProviderModelList = JsonResponse<'listProviderModels', 200>;
export type ProviderModel = ProviderModelList['models'][number];

export type NewProfile = RequestBody<'createProfile'>;
export type MediaUpload = RequestBody<'uploadMedia'>;
export type ScheduleInput = RequestBody<'createSchedule'>;
export type SchedulePatch = RequestBody<'updateSchedule'>;
export type Schedule = JsonResponse<'listSchedules', 200>[number];
export type Subscription = JsonResponse<'listSubscriptions', 200>[number];
export type ProfilePatch = RequestBody<'updateProfile'>;
export type NewChannel = RequestBody<'createChannel'>;
export type ChannelPatch = RequestBody<'updateChannel'>;
export type NewProvider = RequestBody<'createProvider'>;
export type ModelDefaultsInput = RequestBody<'setModelDefaults'>;
export type DecisionsStatus = JsonResponse<'getDecisions', 200>;
export type DecisionsSettingsPatch = RequestBody<'updateDecisionsSettings'>;
export type SshKey = JsonResponse<'listSshKeys', 200>[number];
export type RemoteMachine = JsonResponse<'listRemoteMachines', 200>[number];

/** What a model is chosen from: the providers, the models each offers, the installation's defaults. */
export type ModelCatalog = {
  providers: Provider[];
  /** One entry per usable provider, keyed by provider id. Absent while a list never arrived. */
  providerModels: Record<string, ProviderModelList>;
  modelDefaults: ModelDefaults;
};

/** Runs an action, shows its outcome and reloads the profile. False means it failed. */
export type Mutation = (action: () => Promise<unknown>, message?: string) => Promise<boolean>;
