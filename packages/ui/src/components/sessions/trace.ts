import type { ToolStep } from '../../lib/api';
import type { ThoughtStep } from './thought-line';
import { isMcpName, toolLabel } from './tool-labels';

const failures: Partial<Record<ToolStep['status'], string>> = {
  failed: 'Failed',
  refused: 'Refused by the server',
  uncertain: 'Outcome unknown',
  stopped: 'Did not finish',
};

/** One tool as a line of the Thought Line's trace, in the words the panel uses for it. */
export function thoughtOf(step: ToolStep, run?: string): ThoughtStep {
  const failed = failures[step.status];

  return {
    key: step.toolCallId,
    text: toolLabel(step.toolName, step.mcp),
    status: step.status === 'running' ? 'running' : failed ? 'failed' : 'done',
    ...(failed ? { note: failed, ...(step.error ? { detail: step.error } : {}) } : {}),
    ...(step.input !== undefined
      ? { input: { text: step.input, truncated: Boolean(step.inputTruncated) } }
      : {}),
    ...(step.output !== undefined
      ? { output: { text: step.output, truncated: Boolean(step.outputTruncated) } }
      : {}),
    ...(step.mcp || isMcpName(step.toolName) ? { json: true } : {}),
    ...(step.diff ? { diff: step.diff } : {}),
    ...(step.brief ? { brief: true } : {}),
    ...(run ? { run } : {}),
  };
}

/** The tools of a turn as the Thought Line's trace; `run`, the turn, for reading one whole. */
export const traceOf = (steps: ToolStep[], run?: string): ThoughtStep[] =>
  steps.map((step) => thoughtOf(step, run));
