import type { PanelUsage } from '@jian/contracts';
import { type Client, profile } from './params';
import { result } from './result';
import type { NewSecret, ScheduleInput, SchedulePatch, SecretPatch } from './types';

/** What the agent carries between runs: what it remembers and what it knows how to do. */
export const resourceCalls = (client: Client) => ({
  /** Notifications on this device: the key to subscribe with, and the subscription itself. */
  pushKey: () => result(client.GET('/v1/push/key')),
  subscribePush: (body: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    result(client.PUT('/v1/push/subscriptions', { body })),
  unsubscribePush: (endpoint: string) =>
    result(client.POST('/v1/push/subscriptions/remove', { body: { endpoint } })),
  sshKeys: () => result(client.GET('/v1/ssh-keys')),
  createSshKey: (body: { name: string }) => result(client.POST('/v1/ssh-keys', { body })),
  deleteSshKey: (keyId: string) =>
    result(client.DELETE('/v1/ssh-keys/{keyId}', { params: { path: { keyId } } })),
  secrets: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/secrets', { params: profile(profileId) })),
  createSecret: (profileId: string, body: NewSecret) =>
    result(client.POST('/v1/profiles/{profileId}/secrets', { params: profile(profileId), body })),
  updateSecret: (profileId: string, secretId: string, body: SecretPatch) =>
    result(
      client.PATCH('/v1/profiles/{profileId}/secrets/{secretId}', {
        params: { path: { profileId, secretId } },
        body,
      }),
    ),
  deleteSecret: (profileId: string, secretId: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/secrets/{secretId}', {
        params: { path: { profileId, secretId } },
      }),
    ),
  devices: () => result(client.GET('/v1/devices')),
  createDevicePairing: () => result(client.POST('/v1/devices/pairings')),
  updateDevice: (deviceId: string, body: { name?: string; previews?: boolean }) =>
    result(client.PATCH('/v1/devices/{deviceId}', { params: { path: { deviceId } }, body })),
  revokeDevice: (deviceId: string) =>
    result(client.DELETE('/v1/devices/{deviceId}', { params: { path: { deviceId } } })),
  remoteMachines: () => result(client.GET('/v1/remote/machines')),
  createRemoteMachine: (body: { name: string }) =>
    result(client.POST('/v1/remote/machines', { body })),
  rotateRemoteMachineCredentials: (machineId: string) =>
    result(
      client.POST('/v1/remote/machines/{machineId}/rotate', {
        params: { path: { machineId } },
      }),
    ),
  updateRemoteMachine: (machineId: string) =>
    result(
      client.POST('/v1/remote/machines/{machineId}/update', {
        params: { path: { machineId } },
      }),
    ),
  deleteRemoteMachine: (machineId: string) =>
    result(client.DELETE('/v1/remote/machines/{machineId}', { params: { path: { machineId } } })),
  conversationSubagents: (profileId: string, sessionId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/sessions/{sessionId}/subagents', {
        params: { path: { profileId, sessionId } },
      }),
    ),
  memories: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/memories', { params: profile(profileId) })),
  forget: (profileId: string, memoryKey: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/memories/{memoryKey}', {
        params: { path: { profileId, memoryKey } },
      }),
    ),
  editMemory: (profileId: string, memoryKey: string, content: string, expectedVersion: number) =>
    result(
      client.PUT('/v1/profiles/{profileId}/memories/{memoryKey}', {
        params: { path: { profileId, memoryKey } },
        body: { content, expectedVersion },
      }),
    ),
  linkMemories: (profileId: string, memoryKey: string, linkedKey: string) =>
    result(
      client.PUT('/v1/profiles/{profileId}/memories/{memoryKey}/links/{linkedKey}', {
        params: { path: { profileId, memoryKey, linkedKey } },
      }),
    ),
  setMemoryProjects: (profileId: string, memoryKey: string, projectIds: string[]) =>
    result(
      client.PUT('/v1/profiles/{profileId}/memories/{memoryKey}/projects', {
        params: { path: { profileId, memoryKey } },
        body: { projectIds },
      }),
    ),
  unlinkMemories: (profileId: string, memoryKey: string, linkedKey: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/memories/{memoryKey}/links/{linkedKey}', {
        params: { path: { profileId, memoryKey, linkedKey } },
      }),
    ),
  stats: (profileId: string, days: number) =>
    result(
      client.GET('/v1/profiles/{profileId}/stats', {
        params: { path: { profileId }, query: { days } },
      }),
    ),
  /** How much of the Claude and Codex subscription windows is used, for every agent at once. */
  subscriptionUsage: () => result(client.GET('/v1/subscription-usage')),
  schedules: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/schedules', { params: profile(profileId) })),
  createSchedule: (profileId: string, body: ScheduleInput) =>
    result(client.POST('/v1/profiles/{profileId}/schedules', { params: profile(profileId), body })),
  updateSchedule: (profileId: string, scheduleId: string, body: SchedulePatch) =>
    result(
      client.PATCH('/v1/profiles/{profileId}/schedules/{scheduleId}', {
        params: { path: { profileId, scheduleId } },
        body,
      }),
    ),
  deleteSchedule: (profileId: string, scheduleId: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/schedules/{scheduleId}', {
        params: { path: { profileId, scheduleId } },
      }),
    ),
  scheduleHistory: (profileId: string, scheduleId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/schedules/{scheduleId}/history', {
        params: { path: { profileId, scheduleId } },
      }),
    ),
  settings: () => result(client.GET('/v1/settings')),
  updateSettings: (body: {
    timeZone?: string | null;
    newChatProtection?: 'ask' | 'auto' | 'full';
    telemetry?: boolean;
  }) => result(client.PUT('/v1/settings', { body })),
  /**
   * The panel's counts of its own use, through this client like any other call, so with the
   * owner's credential. `leaving` asks for `keepalive`, so a report sent as the page closes still
   * goes; only then, since a host that forwards requests by a scheme of its own may refuse it.
   */
  reportPanelUsage: (body: PanelUsage, leaving = false) =>
    result(client.POST('/v1/telemetry/panel-usage', { body, keepalive: leaving })),
  runSchedule: (profileId: string, scheduleId: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/schedules/{scheduleId}/run', {
        params: { path: { profileId, scheduleId } },
      }),
    ),
  skills: () => result(client.GET('/v1/skills')),
  builtinSkills: () => result(client.GET('/v1/built-in-skills')),
  createSkill: (body: { name: string; description: string; instructions: string }) =>
    result(client.POST('/v1/skills', { body })),
  updateSkill: (name: string, body: { description?: string; instructions?: string }) =>
    result(client.PATCH('/v1/skills/{name}', { params: { path: { name } }, body })),
  deleteSkill: (name: string) =>
    result(client.DELETE('/v1/skills/{name}', { params: { path: { name } } })),
  setSkillEnabled: (name: string, enabled: boolean) =>
    result(
      client.PUT('/v1/skills/{name}/enabled', { params: { path: { name } }, body: { enabled } }),
    ),
  importSkill: (url: string) => result(client.POST('/v1/skills/import', { body: { url } })),
  skillUpstream: (name: string) =>
    result(client.GET('/v1/skills/{name}/upstream', { params: { path: { name } } })),
  updateSkillFromSource: (name: string) =>
    result(client.POST('/v1/skills/{name}/update', { params: { path: { name } } })),
});
