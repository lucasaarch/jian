import type { ToolStep } from '../../lib/api';

/** What the panel calls each tool, so the owner reads an action instead of a function name. */
const toolLabels: Record<string, string> = {
  analyze_media: 'looking at an attachment',
  send_file: 'sending a file',
  save_attachment: 'saving an attachment',
  compact_context: 'compacting its context',
  load_tools: 'loading tools',
  generate_image: 'drawing an image',
  generate_speech: 'recording a voice reply',
  list_speech_voices: 'choosing a voice',
  create_checkpoint: 'saving its progress',
  read_memories: 'reading its memories',
  remember: 'saving a memory',
  forget_memory: 'deleting a memory',
  list_schedules: 'checking its schedules',
  create_schedule: 'scheduling something',
  update_schedule: 'changing a schedule',
  delete_schedule: 'deleting a schedule',
  link_memories: 'linking memories',
  unlink_memories: 'unlinking memories',
  list_sessions: 'looking through its conversations',
  read_session: 'reading another conversation',
  load_skill: 'loading a skill',
  search_history: 'searching the history',
  read_artifact: 'reading a large result',
  list_activities: 'checking what is under way',
  read_run_checkpoints: 'reviewing the steps of a run',
  send_session_message: 'writing to another conversation',
  list_agents: 'looking up the other agents',
  ask_agent: 'asking another agent',
  read_inbox: 'reading its inbox',
  acquire_resource: 'reserving a resource',
  release_resource: 'releasing a resource',
  message_contact: 'writing to a contact',
  list_contacts: 'looking up its contacts',
  run_command: 'running a command',
  read_file: 'reading a file',
  edit_file: 'editing a file',
  write_file: 'writing a file',
  find_files: 'finding files',
  search_files: 'searching files',
  list_directory: 'listing a directory',
  web_search: 'searching the web',
  fetch_url: 'reading a page',
  create_skill: 'writing a skill',
  update_skill: 'rewriting a skill',
  delete_skill: 'removing a skill',
  update_identity: 'adjusting its own identity',
  read_identity: 'rereading its own identity',
  create_profile: 'creating an agent',
  throw_confetti: 'throwing confetti',
  spawn_subagent: 'handing work to an agent',
  ask_jev: 'asking Jev',
  ask_user: 'asking you',
  load_mcp_tools: 'loading tools',
  search_mcp_tools: 'looking for a tool',
  set_session_objective: 'setting an objective',
  complete_session_objective: 'finishing an objective',
  block_session_objective: 'pausing an objective for your input',
  cancel_session_objective: 'dropping an objective',
  cancel_subagent: 'stopping an agent it started',
  browser_control: 'using the browser',
  open_in_inspector: 'opening it in the Inspector',
  react_to_message: 'reacting to a message',
  read_activity_stats: 'reading its activity',
  read_usage_runs: 'reading its runs',
  github_git: 'working with a GitHub repository',
  create_ssh_key: 'creating an SSH key',
  delete_ssh_key: 'deleting an SSH key',
  list_ssh_keys: 'looking up its SSH keys',
  list_remote_machines: 'looking up the machines',
  update_remote_machine: 'changing a machine',
  run_remote_command: 'running a command on a machine',
  remote_computer: "using a machine's screen",
  pull_remote_file: 'copying a file from a machine',
  push_remote_file: 'copying a file to a machine',
  x_post: 'posting on X',
  x_upload_media: 'uploading media to X',
  x_download_dm_media: 'saving an attachment from an X message',
};

/**
 * How the gateway names a tool server's tool: `mcp__<server>_<tool, cut>_<8 hex>`. Only steps
 * recorded before the step carried `mcp` need it read back.
 */
const MCP_NAME = /^mcp__(.+)_[0-9a-f]{8}$/;

export const isMcpName = (name: string) => MCP_NAME.test(name);

/**
 * A tool as the panel names it: Jian's own as an action, a tool server's as the server and the
 * tool by their own names, which is how the owner set them up and how the server documents them.
 */
export function toolLabel(name: string, mcp?: ToolStep['mcp']): string {
  if (mcp) return `${mcp.server} · ${mcp.tool}`;
  // Older steps: the server and the tool run together and cannot be told apart reliably.
  const older = MCP_NAME.exec(name)?.[1];
  if (older) return older;

  const label = toolLabels[name] ?? name.replaceAll('_', ' ');
  return `${label[0]?.toUpperCase() ?? ''}${label.slice(1)}`;
}
