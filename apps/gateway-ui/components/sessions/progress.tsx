'use client';

import { LoaderCircle, PencilLine, Sparkles, Wrench } from 'lucide-react';
import type { Run } from '../../lib/api';

/** What the panel calls each tool, so the owner reads an action instead of a function name. */
const toolLabels: Record<string, string> = {
  read_memories: 'reading its memories',
  remember: 'saving a memory',
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
  update_skills: 'rewriting its own skills',
  update_identity: 'adjusting its own identity',
  read_identity: 'rereading its own identity',
  create_profile: 'creating a profile',
};

/**
 * What the agent is doing, while it does it. The panel is the only surface that names tools:
 * a chat channel gets the answer taking shape and nothing else.
 */
export function RunProgress({ run }: { run: Run }) {
  const progress = run.progress;
  const phase =
    run.status === 'queued'
      ? 'Queued'
      : progress?.phase === 'tool'
        ? `Using tools — ${toolLabels[progress.tool ?? ''] ?? progress.tool}`
        : progress?.phase === 'writing'
          ? 'Writing the answer'
          : 'Thinking';

  const icon =
    progress?.phase === 'tool' ? (
      <Wrench size={15} />
    ) : progress?.phase === 'writing' ? (
      <PencilLine size={15} />
    ) : (
      <Sparkles size={15} />
    );

  return (
    <article className="message assistant pending" aria-live="polite">
      <header>
        <strong>Agent</strong>
        <span className="run-phase">
          {icon}
          {phase}
          <LoaderCircle size={13} className="spin" aria-hidden="true" />
        </span>
      </header>
      {progress?.text ? (
        <p>
          {progress.text}
          <span className="caret" aria-hidden="true" />
        </p>
      ) : (
        <p className="muted">
          {progress?.steps ? `${progress.steps} steps so far.` : 'Getting ready to answer.'}
        </p>
      )}
    </article>
  );
}
