import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Save, Trash2 } from 'lucide-react';
import { fn } from 'storybook/test';
import { Button } from './button';

const meta = {
  title: 'UI/Button',
  component: Button,
  parameters: { layout: 'centered' },
  args: { children: 'Save it', onClick: fn() },
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'quiet', 'danger'] },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Secondary: Story = {
  args: { variant: 'secondary', children: 'Sign in with ChatGPT' },
};
export const Quiet: Story = { args: { variant: 'quiet', children: 'Manage' } };
export const Danger: Story = { args: { variant: 'danger', children: 'Confirm' } };
export const Busy: Story = { args: { busy: true, children: 'Saving' } };
export const Disabled: Story = { args: { disabled: true } };

/** Every variant side by side, with an icon, as the screens use them. */
export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button>
        <Save size={16} /> Save it
      </Button>
      <Button variant="secondary">Sign in with ChatGPT</Button>
      <Button variant="quiet">Manage</Button>
      <Button variant="danger">
        <Trash2 size={16} /> Remove it
      </Button>
      <Button busy>Saving</Button>
    </div>
  ),
};
