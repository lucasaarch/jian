import { type LibrarySkill, type McpServer, OPT_IN_SKILLS, type Skill } from '@jian/contracts';
import { isGitHubIntegrationServer } from '../../agent/github-mcp.js';
import { onOwnerComputer } from '../../agent/workspace-home.js';
import { aboutJian } from './about-jian.js';
import { activity } from './activity.js';
import { approvals } from './approvals.js';
import { channelReplies } from './channel-replies.js';
import { codingWork } from './coding-work.js';
import { conversations } from './conversations.js';
import { github } from './github.js';
import { githubMcp } from './github-mcp.js';
import { handlingErrors } from './handling-errors.js';
import { jevJudgment } from './jev-judgment.js';
import { jianConfiguration } from './jian-configuration.js';
import { longRunningWork } from './long-running-work.js';
import { machineTools, machineToolsFor } from './machine-tools.js';
import { managingContext } from './managing-context.js';
import { managingYourself } from './managing-yourself.js';
import { mcpServers } from './mcp-servers.js';
import { media } from './media.js';
import { memoryKeeping } from './memory-keeping.js';
import { ownerAndContacts } from './owner-and-contacts.js';
import { remoteControl } from './remote-control.js';
import { schedules } from './schedules.js';
import { skillCreator } from './skill-creator.js';
import { sshKeys, sshKeysFor } from './ssh-keys.js';
import { caveman } from './vendored/caveman.js';
import { discernmentNudge } from './vendored/discernment-nudge.js';
import { ponytailSkills } from './vendored/ponytail.js';
import { videoProduction } from './video-production.js';
import { webResearch } from './web-research.js';
import { workingWithAgents } from './working-with-agents.js';
import { worktrees } from './worktrees.js';
import { x } from './x.js';

/**
 * Skills every agent carries without importing anything. They ship with the gateway rather
 * than being copied into the library: a default stored in a row goes stale the day it is
 * written, counts against what the owner may add, and leaves no way to say which instructions
 * an installation was actually running.
 */
const ALWAYS: readonly Skill[] = [
  aboutJian,
  jianConfiguration,
  activity,
  ownerAndContacts,
  approvals,
  channelReplies,
  memoryKeeping,
  conversations,
  schedules,
  skillCreator,
  media,
  videoProduction,
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
  x,
  // Starts switched off on a new installation (OPT_IN_SKILLS); the owner turns it on in Skills.
  discernmentNudge,
];

/**
 * These describe tools that exist only with MCP servers on the run, or with the server the
 * GitHub integration attaches. Offered without them, a skill would teach tools the agent does
 * not have, and it would say it cannot do what the skill promised.
 */
const MCP: readonly Skill[] = [mcpServers, githubMcp];

export const builtinSkillNames: ReadonlySet<string> = new Set(
  [...ALWAYS, ...MCP, github, worktrees].map((skill) => skill.name),
);

/**
 * The two whose truth depends on the host, not on the run. Swapped here rather than at `load_skill`
 * so the panel shows the owner what the agent is told, on either host.
 */
function forThisHost(skill: Skill): Skill {
  if (skill === machineTools) return machineToolsFor(onOwnerComputer());
  if (skill === sshKeys) return sshKeysFor(onOwnerComputer());
  return skill;
}

/** What a run has beyond the MCP servers, which decides the skills that teach it. */
export type RunSkills = {
  /** The run has the worktree tools; a skill about them would send it after tools it lacks. */
  worktrees?: boolean;
};

/** `servers` are the MCP servers a run reaches: the installation's, and any lent to it. */
export function builtinSkills(
  servers: readonly McpServer[],
  has: RunSkills = {},
): readonly Skill[] {
  return [
    ...ALWAYS.map(forThisHost),
    ...(servers.length ? MCP : []),
    ...(servers.some(isGitHubIntegrationServer) ? [github] : []),
    ...(has.worktrees ? [worktrees] : []),
  ];
}

/**
 * The installation's library as a run reads it: its skills, and the names switched off, which
 * may be a library skill's or a built-in one's.
 */
export type SkillLibraryState = {
  skills: readonly LibrarySkill[];
  disabled: readonly string[];
};

/** An installation whose owner has added nothing and switched nothing. */
export const NO_LIBRARY: SkillLibraryState = { skills: [], disabled: OPT_IN_SKILLS };

/**
 * What any agent can load this run: the built-in skills and the library's, less what is
 * switched off. A library skill wins over a built-in of the same name, on or off, so an owner
 * who disagrees with a default replaces it by importing over it.
 */
export function availableSkills(
  library: SkillLibraryState,
  servers: readonly McpServer[],
  has: RunSkills = {},
): Skill[] {
  const held = new Set(library.skills.map((skill) => skill.name));
  const disabled = new Set(library.disabled);

  return [
    ...builtinSkills(servers, has).filter(
      (skill) => !held.has(skill.name) && !disabled.has(skill.name),
    ),
    // What the agent follows, without the library's bookkeeping.
    ...library.skills
      .filter((skill) => skill.enabled)
      .map(({ name, description, instructions, origin, writtenBy }) => ({
        name,
        description,
        instructions,
        ...(origin ? { origin } : {}),
        ...(writtenBy ? { writtenBy } : {}),
      })),
  ];
}

export function findSkill(
  library: SkillLibraryState,
  servers: readonly McpServer[],
  name: string,
  has: RunSkills = {},
): Skill | undefined {
  return availableSkills(library, servers, has).find((skill) => skill.name === name);
}
