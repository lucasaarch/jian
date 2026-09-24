import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useWorkspace } from '../../lib/workspace';
import { profileData, sectionProps } from '../../stories/section';
import { withWorkspace } from '../../stories/workspace';
import { Memories } from '.';

const meta = {
  title: 'Sections/Memories',
  parameters: { layout: 'padded' },
  // Edits, links and deletions reload the workspace, as they do in the panel.
  decorators: [withWorkspace],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Live() {
  const { data, mutate } = useWorkspace();

  return <Memories {...sectionProps(data ? { data } : {})} mutate={mutate} />;
}

export const Some: Story = { render: () => <Live /> };

export const None: Story = {
  render: () => <Memories {...sectionProps({ data: { ...profileData, memories: [] } })} />,
};
