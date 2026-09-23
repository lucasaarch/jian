import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { releases } from '../../stories/fixtures';
import { updatedHandlers } from '../../stories/handlers';
import { ReleaseDialog } from './dialog';
import { Markdown } from './markdown';

const meta = {
  title: 'Releases',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** What opens once after an update. */
export const WhatsNew: Story = {
  parameters: { msw: { handlers: updatedHandlers } },
  render: () => <ReleaseDialog />,
};

/** The Markdown a note may use, rendered as the dialog renders it. */
export const NoteText: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className="release-notes max-w-xl">
      <Markdown text={releases.unseen[0]?.body ?? ''} />
    </div>
  ),
};
