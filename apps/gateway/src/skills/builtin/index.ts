import type { Capability, ProfessionAuthority, Profile, Skill } from '@jian/contracts';
import { profileAuthority } from '../../professions/effective.js';
import { CapabilityDenied, requireCapability } from '../../professions/policy.js';
import { aboutJian } from './about-jian.js';
import { activity } from './activity.js';
import { channelReplies } from './channel-replies.js';
import { codingWork } from './coding-work.js';
import { conversations } from './conversations.js';
import { githubMcp } from './github-mcp.js';
import { handlingErrors } from './handling-errors.js';
import { jevJudgment } from './jev-judgment.js';
import { jianConfiguration } from './jian-configuration.js';
import { longRunningWork } from './long-running-work.js';
import { machineTools } from './machine-tools.js';
import { managingContext } from './managing-context.js';
import { managingYourself } from './managing-yourself.js';
import { mcpServers } from './mcp-servers.js';
import { media } from './media.js';
import { memoryKeeping } from './memory-keeping.js';
import { ownerAndContacts } from './owner-and-contacts.js';
import { remoteControl } from './remote-control.js';
import { schedules } from './schedules.js';
import { skillCreator } from './skill-creator.js';
import { sshKeys } from './ssh-keys.js';
import { stickers } from './stickers.js';
import { subscriptions } from './subscriptions.js';
import { caveman } from './vendored/caveman.js';
import { discernmentNudge } from './vendored/discernment-nudge.js';
import { ponytailSkills } from './vendored/ponytail.js';
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
  jianConfiguration,
  activity,
  ownerAndContacts,
  channelReplies,
  memoryKeeping,
  conversations,
  schedules,
  subscriptions,
  skillCreator,
  media,
  sshKeys,
  longRunningWork,
  managingContext,
  handlingErrors,
  jevJudgment,
  caveman,
  // Starts switched off on a new profile (OPT_IN_SKILLS); the owner turns it on in Skills.
  discernmentNudge,
];

/** Profession-specific guidance follows the profession's fixed capabilities. MCP guidance also
 * requires a configured server: profession authority does not create an external integration.
 */
const SELF_MANAGED: readonly Skill[] = [managingYourself];
const AGENTS: readonly Skill[] = [workingWithAgents];
const SHELL: readonly Skill[] = [machineTools, codingWork, remoteControl, ...ponytailSkills];
const WEB: readonly Skill[] = [webResearch];
const MCP: readonly Skill[] = [mcpServers, githubMcp];
const STICKERS: readonly Skill[] = [stickers];

export const builtinSkillNames: ReadonlySet<string> = new Set(
  [...ALWAYS, ...AGENTS, ...SELF_MANAGED, ...SHELL, ...WEB, ...MCP, ...STICKERS].map(
    (skill) => skill.name,
  ),
);

/** Any listed capability suffices; an empty list needs only skills.read. Names, not
 * owner-supplied bodies, determine requirements, including imported replacements.
 */
const skillCapabilities: Readonly<Record<string, readonly Capability[]>> = {
  [aboutJian.name]: [],
  [jianConfiguration.name]: [],
  [activity.name]: ['activity.read'],
  [ownerAndContacts.name]: ['conversation.read'],
  [channelReplies.name]: [],
  [memoryKeeping.name]: ['memory.use'],
  [conversations.name]: ['conversation.read'],
  [schedules.name]: ['schedules.manage'],
  [subscriptions.name]: ['subscriptions.github'],
  [skillCreator.name]: ['skills.write'],
  [media.name]: ['media.use'],
  [sshKeys.name]: ['ssh.manage'],
  [longRunningWork.name]: ['tasks.delegate'],
  [managingContext.name]: ['conversation.control'],
  [handlingErrors.name]: [],
  [jevJudgment.name]: ['decisions.query'],
  [caveman.name]: [],
  [discernmentNudge.name]: [],
  [managingYourself.name]: ['identity.manage'],
  [workingWithAgents.name]: ['peers.call'],
  [machineTools.name]: ['process.exec'],
  [codingWork.name]: ['process.exec'],
  [remoteControl.name]: ['remote.control'],
  ...Object.fromEntries(ponytailSkills.map((skill) => [skill.name, ['process.exec'] as const])),
  [webResearch.name]: ['web.browse'],
  [mcpServers.name]: ['mcp.http', 'mcp.stdio'],
  [githubMcp.name]: ['mcp.http', 'mcp.stdio'],
  [stickers.name]: ['media.use'],
};

function skillAllowed(name: string, authority: ProfessionAuthority | undefined): boolean {
  if (authority === undefined) return true;
  const permits = (capability: Capability) => {
    try {
      requireCapability(authority, capability);
      return true;
    } catch (error) {
      if (!(error instanceof CapabilityDenied)) throw error;
      return false;
    }
  };
  if (!permits('skills.read')) return false;
  if (!builtinSkillNames.has(name)) return true;
  const required = skillCapabilities[name];
  return required !== undefined && (required.length === 0 || required.some(permits));
}

export function builtinSkills(
  profile:
    | Profile
    | Pick<Profile, 'allowSelfManagement' | 'allowWebSearch' | 'mcpServers' | 'reachableByAgents'>,
  authority?: ProfessionAuthority,
): readonly Skill[] {
  const hasProfessionField = 'professionId' in profile;
  const classified = hasProfessionField && profile.professionId !== null;
  const effective = hasProfessionField
    ? profileAuthority(profile as Profile, authority)
    : authority;
  const permits = (capability: Capability) => {
    if (effective === undefined) return false;
    try {
      requireCapability(effective, capability);
      return true;
    } catch (error) {
      if (!(error instanceof CapabilityDenied)) throw error;
      return false;
    }
  };
  return [
    ...ALWAYS,
    ...(classified ? (permits('peers.call') ? AGENTS : []) : AGENTS),
    ...(classified
      ? permits('identity.manage')
        ? SELF_MANAGED
        : []
      : profile.allowSelfManagement
        ? SELF_MANAGED
        : []),
    ...(classified
      ? [
          ...(permits('process.exec') ? [machineTools, codingWork, ...ponytailSkills] : []),
          ...(permits('remote.control') ? [remoteControl] : []),
        ]
      : SHELL),
    ...(classified ? (permits('web.browse') ? WEB : []) : profile.allowWebSearch ? WEB : []),
    ...(profile.mcpServers.some(
      (server) => !classified || permits(server.transport === 'http' ? 'mcp.http' : 'mcp.stdio'),
    )
      ? MCP
      : []),
    ...STICKERS,
  ].filter((skill) => skillAllowed(skill.name, effective));
}

/**
 * What the profile can load this run. An imported skill wins over a built-in of the same
 * name, so an owner who disagrees with a default replaces it by importing over it.
 */
export function availableSkills(profile: Profile, authority?: ProfessionAuthority): Skill[] {
  const effective = profileAuthority(profile, authority);
  const own = new Set(profile.skills.map((skill) => skill.name));
  const disabled = new Set(profile.disabledSkills);
  const classified = profile.professionId !== null;

  return [
    ...builtinSkills(profile, effective).filter(
      (skill) => !own.has(skill.name) && (classified || !disabled.has(skill.name)),
    ),
    ...profile.skills.filter((skill) => skillAllowed(skill.name, effective)),
  ];
}

export function findSkill(
  profile: Profile,
  name: string,
  authority?: ProfessionAuthority,
): Skill | undefined {
  return availableSkills(profile, authority).find((skill) => skill.name === name);
}
