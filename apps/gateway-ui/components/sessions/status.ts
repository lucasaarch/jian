import type { Run } from '../../lib/api';

export const running = (run?: Run) => run?.status === 'queued' || run?.status === 'running';

export const waiting = (run?: Run) => run?.status === 'waiting';

export const statusLabels = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting for your answer',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};
