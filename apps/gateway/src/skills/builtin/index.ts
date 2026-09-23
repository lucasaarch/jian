import type { Profile, Skill } from '@jian/contracts';
import { aboutJian } from './about-jian.js';
import { channelReplies } from './channel-replies.js';
import { longRunningWork } from './long-running-work.js';
import { machineTools } from './machine-tools.js';
import { memoryKeeping } from './memory-keeping.js';
import { ownerAndContacts } from './owner-and-contacts.js';
import { discernmentNudge } from './vendored/discernment-nudge.js';
import { workingWithAgents } from './working-with-agents.js';
import { writingYourSkills } from './writing-your-skills.js';

/**
 * Skills every profile carries without importing anything. They ship with the gateway rather
 * than being copied into each profile: a default that lives in the profile row goes stale the
 * day it is written, counts against the twenty the owner may import, and leaves no way to say
 * which instructions an installation was actually running.
 */
const ALWAYS: readonly Skill[] = [
  aboutJian,
  ownerAndContacts,
  channelReplies,
  memoryKeeping,
  workingWithAgents,
  longRunningWork,
  discernmentNudge,
];

/** Described in terms of a tool that only exists when the owner allows self-management. */
const SELF_MANAGED: readonly Skill[] = [writingYourSkills];

/** Described in terms of the command tools, which only exist when the owner allows the shell. */
const SHELL: readonly Skill[] = [machineTools];

export const builtinSkillNames: ReadonlySet<string> = new Set(
  [...ALWAYS, ...SELF_MANAGED, ...SHELL].map((skill) => skill.name),
);

export function builtinSkills(
  profile: Pick<Profile, 'allowSelfManagement' | 'allowShell'>,
): readonly Skill[] {
  return [
    ...ALWAYS,
    ...(profile.allowSelfManagement ? SELF_MANAGED : []),
    ...(profile.allowShell ? SHELL : []),
  ];
}

/**
 * What the profile can load this run. An imported skill wins over a built-in of the same
 * name, so an owner who disagrees with a default replaces it by importing over it.
 */
export function availableSkills(profile: Profile): Skill[] {
  const own = new Set(profile.skills.map((skill) => skill.name));
  const disabled = new Set(profile.disabledSkills);

  return [
    ...builtinSkills(profile).filter((skill) => !own.has(skill.name) && !disabled.has(skill.name)),
    ...profile.skills,
  ];
}

export function findSkill(profile: Profile, name: string): Skill | undefined {
  return availableSkills(profile).find((skill) => skill.name === name);
}
