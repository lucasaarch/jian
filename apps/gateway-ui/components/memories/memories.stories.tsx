import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { profileData, sectionProps } from '../../stories/section';
import { Memories } from '.';

const meta = {
  title: 'Sections/Memories',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Some: Story = { render: () => <Memories {...sectionProps()} /> };

export const None: Story = {
  render: () => <Memories {...sectionProps({ data: { ...profileData, memories: [] } })} />,
};
