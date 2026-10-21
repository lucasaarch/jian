import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { HttpResponse, http } from 'msw';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { gatewayApi } from '../../lib/api';
import { withWorkspace } from '../../stories/workspace';
import { RemoteMachines } from './index';

const meta = {
  title: 'Sections/Remote Control',
  decorators: [withWorkspace],
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {
  render: () => <RemoteMachines api={gatewayApi()} />,
};

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [http.get('*/v1/remote/machines', () => HttpResponse.json([]))],
    },
  },
  render: () => <RemoteMachines api={gatewayApi()} />,
};

/** Add-machine modal with the multiselect agent picker. */
export const AddMachine: Story = {
  render: () => <RemoteMachines api={gatewayApi()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByRole('heading', { name: 'Remote Control' })).toBeVisible(),
    );
    await userEvent.click(canvas.getByRole('button', { name: /Add machine/i }));
    await waitFor(() =>
      expect(canvas.getByRole('heading', { name: 'Add a machine' })).toBeVisible(),
    );
    await userEvent.click(canvas.getByLabelText('Agents allowed to execute commands'));
    await waitFor(() => expect(canvas.getByRole('option', { name: /Zero Two/i })).toBeVisible());
  },
};

/** Post-create token and install command, after submitting the form. */
export const CreatedToken: Story = {
  render: () => <RemoteMachines api={gatewayApi()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByRole('heading', { name: 'Remote Control' })).toBeVisible(),
    );
    await userEvent.click(canvas.getByRole('button', { name: /Add machine/i }));
    await waitFor(() => expect(canvas.getByLabelText('Machine name')).toBeVisible());
    await userEvent.type(canvas.getByLabelText('Machine name'), 'Demo laptop');
    await userEvent.click(canvas.getByLabelText('Agents allowed to execute commands'));
    await waitFor(() => expect(canvas.getByRole('option', { name: /Zero Two/i })).toBeVisible());
    await userEvent.click(canvas.getByRole('option', { name: /Zero Two/i }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(canvas.getByRole('button', { name: 'Create machine' }));
    await waitFor(() =>
      expect(canvas.getByRole('heading', { name: 'Demo laptop created' })).toBeVisible(),
    );
    const npx = canvas.getByLabelText('Any OS (npx)') as HTMLTextAreaElement;
    expect(npx.value).toContain('npx --yes @jian-ai/remote-control@');
    expect(npx.value).toContain('--token ');
    expect(npx.value).toContain('--gateway ');
    expect(npx.value).toContain('--machine ');
    const global = canvas.getByLabelText('Global install') as HTMLTextAreaElement;
    expect(global.value).toContain('npm install -g @jian-ai/remote-control@');
    expect(global.value).toContain('jian-remote install');
    expect(global.value).toContain('--token ');
  },
};
