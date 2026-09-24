import type { Profile, Skill } from '@jian/contracts';
import { aboutJian } from './about-jian.js';
import { channelReplies } from './channel-replies.js';
import { codingWork } from './coding-work.js';
import { conversations } from './conversations.js';
import { longRunningWork } from './long-running-work.js';
import { machineTools } from './machine-tools.js';
import { managingContext } from './managing-context.js';
import { managingYourself } from './managing-yourself.js';
import { mcpServers } from './mcp-servers.js';
import { media } from './media.js';
import { memoryKeeping } from './memory-keeping.js';
import { ownerAndContacts } from './owner-and-contacts.js';
import { schedules } from './schedules.js';
import { skillCreator } from './skill-creator.js';
import { discernmentNudge } from './vendored/discernment-nudge.js';
import { webResearch } from './web-research.js';
import { workingWithAgents } from './working-with-agents.js';

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
  conversations,
  schedules,
  skillCreator,
  media,
  workingWithAgents,
  longRunningWork,
  managingContext,
  // Starts switched off on a new profile (OPT_IN_SKILLS); the owner turns it on in Skills.
  discernmentNudge,
];

/**
 * Each of these describes tools that exist only behind one of the profile's switches, or only
 * with servers configured. Offered without them, a skill would teach tools the agent does not
 * have, and it would say it cannot do what the skill promised.
 */
const SELF_MANAGED: readonly Skill[] = [managingYourself];
const SHELL: readonly Skill[] = [machineTools, codingWork];
const WEB: readonly Skill[] = [webResearch];
const MCP: readonly Skill[] = [mcpServers];

export const builtinSkillNames: ReadonlySet<string> = new Set(
  [...ALWAYS, ...SELF_MANAGED, ...SHELL, ...WEB, ...MCP].map((skill) => skill.name),
);

export function builtinSkills(
  profile: Pick<Profile, 'allowSelfManagement' | 'allowShell' | 'allowWebSearch' | 'mcpServers'>,
): readonly Skill[] {
  return [
    ...ALWAYS,
    ...(profile.allowSelfManagement ? SELF_MANAGED : []),
    ...(profile.allowShell ? SHELL : []),
    ...(profile.allowWebSearch ? WEB : []),
    ...(profile.mcpServers.length ? MCP : []),
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
