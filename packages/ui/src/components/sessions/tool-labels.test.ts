import { expect, it } from 'vitest';
import { statusOf, traceOf } from './progress';

const step = (toolName: string, extra: object = {}) => ({
  toolCallId: toolName,
  toolName,
  status: 'done' as const,
  startedAt: '2026-11-04T10:00:00.000Z',
  ...extra,
});

it("names a tool server's call by its server and tool, and shows it as JSON", () => {
  const [call] = traceOf([
    step('mcp__github_issue_write_056a4702', { mcp: { server: 'github', tool: 'issue_write' } }),
  ]);

  expect(call).toMatchObject({ text: 'github · issue_write', json: true });
});

it('reads an older call without the hash the gateway added to its name', () => {
  const [call] = traceOf([step('mcp__github_issue_write_056a4702')]);

  expect(call).toMatchObject({ text: 'github_issue_write', json: true });
});

it("names Jian's own tools as actions, in the owner's words", () => {
  expect(
    traceOf([step('fetch_url'), step('github_git'), step('x_download_dm_media')]).map(
      (item) => item.text,
    ),
  ).toEqual([
    'Reading a page',
    'Working with a GitHub repository',
    'Saving an attachment from an X message',
  ]);
  expect(traceOf([step('run_command')])[0]).not.toHaveProperty('json');
});

it('says which server tool is running while it runs', () => {
  const run = {
    status: 'running' as const,
    progress: {
      phase: 'tool' as const,
      tool: 'mcp__github_issue_write_056a4702',
      mcp: { server: 'github', tool: 'issue_write' },
      text: '',
      steps: 1,
      updatedAt: '2026-11-04T10:00:00.000Z',
    },
  };

  expect(statusOf(run).label).toBe('github · issue_write');
});
