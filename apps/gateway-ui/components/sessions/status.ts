import type { Run } from '../../lib/api';

export const running = (run?: Run) => run?.status === 'queued' || run?.status === 'running';

export const statusLabels = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};
