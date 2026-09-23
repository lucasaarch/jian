import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Mark } from './mark';

const meta = {
  title: 'UI/Mark',
  component: Mark,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Mark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Large: Story = {};
export const Small: Story = { args: { small: true } };
