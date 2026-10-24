import {
  type Capability,
  type ProfessionAuthority,
  professionAuthoritySchema,
} from '@jian/contracts';
import type { ToolSet } from 'ai';
import { GatewayError } from '../core/errors.js';
import { findProfession } from './catalog.js';
import { CapabilityDenied, requireCapability } from './policy.js';

/** All entries are AND requirements except the two MCP discovery/load controls (OR).
 * load_tools has no grant of its own: create it only after filtering its available tools.
 * send_file's path branch additionally requires workspace.files at execution time.
 */
export const toolCapabilities: Record<string, readonly Capability[]> = {
  list_ssh_keys: ['ssh.manage'],
  create_ssh_key: ['ssh.manage'],
  delete_ssh_key: ['ssh.manage'],
  list_activities: ['activity.read'],
  read_activity_stats: ['activity.read'],
  read_usage_runs: ['activity.read'],
  set_session_objective: ['conversation.control'],
  complete_session_objective: ['conversation.control'],
  block_session_objective: ['conversation.control'],
  cancel_session_objective: ['conversation.control'],
  ask_user: ['conversation.control'],
  compact_context: ['conversation.control'],
  read_memories: ['memory.use'],
  remember: ['memory.use'],
  forget_memory: ['memory.use'],
  link_memories: ['memory.use'],
  unlink_memories: ['memory.use'],
  load_skill: ['skills.read'],
  create_skill: ['skills.write'],
  update_skill: ['skills.write'],
  delete_skill: ['skills.write'],
  ask_jev: ['decisions.query'],
  list_sessions: ['conversation.read'],
  read_session: ['conversation.read'],
  search_history: ['conversation.read'],
  read_inbox: ['conversation.read'],
  send_session_message: ['conversation.send'],
  list_contacts: ['conversation.send'],
  message_contact: ['conversation.send'],
  read_artifact: ['activity.read'],
  read_run_checkpoints: ['activity.read'],
  acquire_resource: ['coordination.lease'],
  release_resource: ['coordination.lease'],
  list_agents: ['peers.call'],
  ask_agent: ['peers.call'],
  spawn_subagent: ['tasks.delegate'],
  read_identity: ['identity.manage'],
  update_identity: ['identity.manage'],
  create_profile: ['profiles.create'],
  list_schedules: ['schedules.manage'],
  create_schedule: ['schedules.manage'],
  update_schedule: ['schedules.manage'],
  delete_schedule: ['schedules.manage'],
  list_subscriptions: ['subscriptions.github'],
  list_sales_campaigns: ['campaigns.read'],
  create_sales_campaign: ['campaigns.manage'],
  update_sales_campaign: ['campaigns.manage'],
  delete_sales_campaign: ['campaigns.manage'],
  record_sales_outcome: ['campaigns.manage'],
  escalate_sales_to_owner: ['campaigns.manage'],
  create_subscription: ['subscriptions.github'],
  update_subscription: ['subscriptions.github'],
  delete_subscription: ['subscriptions.github'],
  read_file: ['workspace.files'],
  find_files: ['workspace.files'],
  search_files: ['workspace.files'],
  list_directory: ['workspace.files'],
  edit_file: ['workspace.files'],
  write_file: ['workspace.files'],
  run_command: ['process.exec'],
  list_remote_machines: ['remote.control'],
  run_remote_command: ['remote.control'],
  remote_computer: ['remote.control'],
  pull_remote_file: ['remote.control'],
  push_remote_file: ['remote.control'],
  web_search: ['web.browse'],
  fetch_url: ['web.browse'],
  analyze_media: ['media.use'],
  send_file: ['media.use', 'conversation.send'],
  save_attachment: ['media.use', 'workspace.files'],
  generate_image: ['media.image', 'conversation.send'],
  find_stickers: ['media.use'],
  send_sticker: ['media.use', 'conversation.send'],
  tag_sticker: ['media.use'],
  load_tools: [],
  search_mcp_tools: ['mcp.http', 'mcp.stdio'],
  load_mcp_tools: ['mcp.http', 'mcp.stdio'],
};

/** Trusted server-derived mappings for dynamic tools; cannot override native classification.
 * Entries require every listed capability. The caller must still enforce actual MCP grants,
 * transport/server identity, resource ACLs and aliases (including inside MCP loaders).
 */
export type AdditionalToolCapabilities = Readonly<Record<string, readonly Capability[]>>;

export class ToolCapabilityDenied extends GatewayError {
  readonly code = 'capability_denied';

  constructor(readonly toolName: string) {
    super(403, `Tool capability denied: ${toolName}`);
  }
}

/** Null is always denied. Callers alone decide whether to use a separate legacy path. */
export function requireToolCapabilities(
  authority: ProfessionAuthority | null,
  name: string,
  input?: unknown,
  additional: AdditionalToolCapabilities = {},
): void {
  const parsed = professionAuthoritySchema.safeParse(authority);
  const profession = parsed.success && findProfession(parsed.data.professionId);
  if (!parsed.success || !profession || parsed.data.policyVersion !== profession.policyVersion) {
    throw new ToolCapabilityDenied(name);
  }
  const required = Object.hasOwn(toolCapabilities, name)
    ? toolCapabilities[name]
    : Object.hasOwn(additional, name)
      ? additional[name]
      : undefined;
  if (!required) throw new ToolCapabilityDenied(name);

  if (name === 'search_mcp_tools' || name === 'load_mcp_tools') {
    const allowed = required.some((capability) => {
      try {
        requireCapability(authority, capability);
        return true;
      } catch (error) {
        if (!(error instanceof CapabilityDenied)) throw error;
        return false;
      }
    });
    if (!allowed) throw new ToolCapabilityDenied(name);
  } else {
    for (const capability of required) requireCapability(authority, capability);
  }

  // Match sendFile's explicit-source selection; ignored path fields do not need file access.
  if (name === 'send_file' && input && typeof input === 'object') {
    const fields = input as Record<string, unknown>;
    if (fields.source === 'path' || (fields.source === undefined && fields.path != null)) {
      requireCapability(authority, 'workspace.files');
    }
  }
}

/** Use BEFORE deferTools/MCP discovery so descriptions and loader schemas do not leak tools.
 * Does not mutate tools. Presentation filtering is not execution authorization.
 */
export function filterToolSet(
  tools: ToolSet,
  authority: ProfessionAuthority | null,
  additional: AdditionalToolCapabilities = {},
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => {
      try {
        requireToolCapabilities(authority, name, undefined, additional);
        return true;
      } catch (error) {
        if (!(error instanceof CapabilityDenied || error instanceof ToolCapabilityDenied))
          throw error;
        return false;
      }
    }),
  );
}

/** Apply AFTER loaders are created, and to tools dynamically added later as well.
 * Re-read effective authority for every call before entering any executor/Decisions wrapper.
 * Undefined is an explicit live legacy decision; null or a callback failure denies execution.
 * This does not replace sensitive service/resource guards or revalidate async work later on.
 */
export function guardToolSet(
  tools: ToolSet,
  currentAuthority: () => Promise<ProfessionAuthority | null | undefined>,
  additional: AdditionalToolCapabilities = {},
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;
      if (!execute) return [name, definition];
      return [
        name,
        {
          ...definition,
          execute: async (input, options) => {
            const authority = await currentAuthority();
            if (authority !== undefined)
              requireToolCapabilities(authority, name, input, additional);
            return execute(input, options);
          },
        } satisfies ToolSet[string],
      ];
    }),
  );
}
