import { type Client, profile } from './params';
import { result } from './result';
import type { ScheduleInput, SchedulePatch } from './types';

/** What the agent carries between runs: what it remembers and what it knows how to do. */
export const resourceCalls = (client: Client) => ({
  sshKeys: () => result(client.GET('/v1/ssh-keys')),
  createSshKey: (body: { name: string }) => result(client.POST('/v1/ssh-keys', { body })),
  deleteSshKey: (keyId: string) =>
    result(client.DELETE('/v1/ssh-keys/{keyId}', { params: { path: { keyId } } })),
  remoteMachines: () => result(client.GET('/v1/remote/machines')),
  createRemoteMachine: (body: { name: string }) =>
    result(client.POST('/v1/remote/machines', { body })),
  rotateRemoteMachineCredentials: (machineId: string) =>
    result(
      client.POST('/v1/remote/machines/{machineId}/rotate', {
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
  subscriptions: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/subscriptions', { params: profile(profileId) })),
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
  runSchedule: (profileId: string, scheduleId: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/schedules/{scheduleId}/run', {
        params: { path: { profileId, scheduleId } },
      }),
    ),
  builtinSkills: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/built-in-skills', { params: profile(profileId) })),
  skillCatalog: (profileId: string, url: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/skill-catalog', {
        params: { path: { profileId }, query: { url } },
      }),
    ),
  importSkill: (profileId: string, url: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/skills/import', {
        params: profile(profileId),
        body: { url },
      }),
    ),
});
