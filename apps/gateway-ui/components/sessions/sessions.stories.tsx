import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { Run } from '../../lib/api';
import * as fixtures from '../../stories/fixtures';
import { ids } from '../../stories/fixtures';
import { sectionProps } from '../../stories/section';
import { Sessions } from '.';
import { History } from './history';
import { RunProgress } from './progress';

const meta = {
  title: 'Sections/Sessions',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = { render: () => <Sessions {...sectionProps()} /> };

export const Conversation: Story = {
  render: () => <History api={sectionProps().api} profileId={ids.zero} sessionId={ids.ownerChat} />,
};

const live = fixtures.runs[0] as Run;
const progress = (
  patch: Partial<NonNullable<Run['progress']>>,
  status: Run['status'] = 'running',
) => ({
  ...live,
  status,
  progress: { phase: 'thinking' as const, text: '', steps: 1, updatedAt: live.updatedAt, ...patch },
});

/** What the chat shows while the agent works, one state at a time. */
export const Progress: Story = {
  render: () => (
    <div className="grid gap-4">
      <RunProgress run={progress({}, 'queued')} />
      <RunProgress run={progress({ phase: 'thinking' })} />
      <RunProgress run={progress({ phase: 'tool', tool: 'web_search', steps: 2 })} />
      <RunProgress
        run={progress({ phase: 'writing', text: 'Mandei, Darling. O Moabe', steps: 3 })}
      />
    </div>
  ),
};
