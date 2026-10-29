import type { RunApproval } from '@jian/contracts';

/**
 * An action as the agent called it, kept beside the run that asked to take it. It is the real
 * call, not its description: `input` is complete and unmasked, so it is never served by the API
 * and leaves the database only to be executed.
 *
 * `pending` sits on the run that parked waiting for a decision. `approved` is copied onto the
 * continuation queued by an approval, which executes it once before its model is called; a
 * rejection copies nothing, so a declined action has no way left to run.
 */
export type RunAction = {
  toolName: string;
  toolCallId: string;
  kind: RunApproval['kind'];
  input: unknown;
  state: 'pending' | 'approved';
};
