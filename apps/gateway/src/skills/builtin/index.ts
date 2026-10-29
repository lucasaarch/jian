import type { McpServer, Profile, Skill } from '@jian/contracts';
import { isGitHubIntegrationServer } from '../../agent/github-mcp.js';
import { aboutJian } from './about-jian.js';
import { activity } from './activity.js';
import { channelReplies } from './channel-replies.js';
import { codingWork } from './coding-work.js';
import { conversations } from './conversations.js';
import { github } from './github.js';
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
  workingWithAgents,
  managingYourself,
  machineTools,
  codingWork,
  remoteControl,
  ...ponytailSkills,
  webResearch,
  stickers,
  // Starts switched off on a new profile (OPT_IN_SKILLS); the owner turns it on in Skills.
  discernmentNudge,
];

/**
 * These describe tools that exist only with MCP servers on the run, or with the server the
 * GitHub integration attaches. Offered without them, a skill would teach tools the agent does
 * not have, and it would say it cannot do what the skill promised.
 */
const MCP: readonly Skill[] = [mcpServers, githubMcp];

export const builtinSkillNames: ReadonlySet<string> = new Set(
  [...ALWAYS, ...MCP, github].map((skill) => skill.name),
);

/** `servers` are the MCP servers a run reaches: the installation's, and any lent to it. */
export function builtinSkills(servers: readonly McpServer[]): readonly Skill[] {
  return [
    ...ALWAYS,
    ...(servers.length ? MCP : []),
    ...(servers.some(isGitHubIntegrationServer) ? [github] : []),
  ];
}

/**
 * What the profile can load this run. An imported skill wins over a built-in of the same
 * name, so an owner who disagrees with a default replaces it by importing over it.
 */
export function availableSkills(profile: Profile, servers: readonly McpServer[]): Skill[] {
  const own = new Set(profile.skills.map((skill) => skill.name));
  const disabled = new Set(profile.disabledSkills);

  return [
    ...builtinSkills(servers).filter((skill) => !own.has(skill.name) && !disabled.has(skill.name)),
    ...profile.skills,
  ];
}

export function findSkill(
  profile: Profile,
  servers: readonly McpServer[],
  name: string,
): Skill | undefined {
  return availableSkills(profile, servers).find((skill) => skill.name === name);
}
