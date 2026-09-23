import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import SignInPage from '../../app/sign-in/page';

const meta = {
  title: 'Pages/Sign in',
  component: SignInPage,
  parameters: {
    layout: 'fullscreen',
    nextjs: { appDirectory: true, navigation: { pathname: '/sign-in' } },
  },
} satisfies Meta<typeof SignInPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
