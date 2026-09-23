import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { HttpResponse, http } from 'msw';
import { fn } from 'storybook/test';
import { handlers } from '../stories/handlers';
import { SignIn } from './sign-in';

const meta = {
  title: 'Sign in',
  component: SignIn,
  parameters: { layout: 'fullscreen' },
  args: { connected: fn() },
} satisfies Meta<typeof SignIn>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The token the owner typed is not the installation's. */
export const WrongToken: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post('*/v1/panel/session', () =>
          HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
        ),
        ...handlers,
      ],
    },
  },
};
