import { expect, it } from 'vitest';
import type { Subagent } from '../../lib/api';
import { reportOf } from './crew';

const agent = {
  runId: '00000000-0000-4000-8000-0000000000a1',
  name: 'Queue migration',
  status: 'completed',
} as Subagent;
const report = [
  'Subagent "Queue migration" (execute) finished.',
  `Run ${agent.runId} status: completed.`,
  'Report: Done.',
].join('\n');

it('reads the report the gateway hands back as that agent’s', () => {
  expect(reportOf({ role: 'user', content: report }, [agent])).toBe(agent);
});

it('leaves a message that only looks like a report as a message', () => {
  // Someone typing the same words, or a report about a run of another conversation.
  expect(reportOf({ role: 'user', content: report }, [])).toBeUndefined();
  expect(
    reportOf({ role: 'user', content: report.replace(agent.runId, 'someone-else') }, [agent]),
  ).toBeUndefined();
  expect(reportOf({ role: 'assistant', content: report }, [agent])).toBeUndefined();
});
